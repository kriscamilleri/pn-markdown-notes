import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteTestDb, getDb, getSpacesDb } from "../../db.js";
import { createSpace } from "../../spaces.js";
import {
  deleteSpaceUploads,
  resolveDatabaseUploadRoot,
  resolveStoredImagePath,
} from "../../spaceStorage.js";
import {
  cleanupTestUser,
  createTestApp,
  getTestToken,
  setupTestUser,
} from "../testHelpers.js";

const FLAG = "SHARED_SPACES_ENABLED";
const ORIGINAL_FLAG = process.env[FLAG];

describe("resumable cross-database Document transfer", () => {
  let app;
  let server;
  let owner;
  let outsider;
  let spaceId;
  const personalFiles = [];

  beforeAll(() => {
    ({ app, server } = createTestApp());
  });

  beforeEach(async () => {
    process.env[FLAG] = "true";
    const stamp = `${Date.now()}-${Math.random()}`;
    owner = await setupTestUser(`transfer-owner-${stamp}@example.test`, "password123");
    outsider = await setupTestUser(`transfer-outsider-${stamp}@example.test`, "password123");
    spaceId = createSpace({ actorUserId: owner.userId, name: "Writers" }).spaceId;
  });

  afterEach(() => {
    const spaces = getSpacesDb();
    spaces.prepare("DELETE FROM space_transfers WHERE actor_user_id IN (?, ?)").run(owner.userId, outsider.userId);
    spaces.prepare("DELETE FROM space_invites WHERE space_id = ?").run(spaceId);
    spaces.prepare("DELETE FROM space_members WHERE space_id = ?").run(spaceId);
    spaces.prepare("DELETE FROM spaces WHERE id = ?").run(spaceId);
    spaces.prepare("DELETE FROM space_user_versions WHERE user_id IN (?, ?)").run(owner.userId, outsider.userId);
    deleteTestDb(`space:${spaceId}`);
    deleteSpaceUploads(spaceId);
    for (const filePath of personalFiles.splice(0)) fs.rmSync(filePath, { force: true });
    cleanupTestUser(owner.userId);
    cleanupTestUser(outsider.userId);
  });

  afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env[FLAG];
    else process.env[FLAG] = ORIGINAL_FLAG;
    return new Promise((resolve) => server.close(resolve));
  });

  const auth = (user) => ({ Authorization: `Bearer ${getTestToken(user.userId)}` });

  function seedPersonalDocument() {
    const dbKey = `user:${owner.userId}`;
    const db = getDb(dbKey);
    const noteId = uuidv4();
    const imageId = uuidv4();
    const missingId = uuidv4();
    const bytes = Buffer.from("verified-image-bytes");
    const relativePath = `${imageId}.png`;
    const uploadRoot = resolveDatabaseUploadRoot(dbKey);
    fs.mkdirSync(uploadRoot, { recursive: true });
    const imagePath = path.join(uploadRoot, relativePath);
    fs.writeFileSync(imagePath, bytes);
    personalFiles.push(imagePath);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    db.prepare(
      `INSERT INTO images (id, user_id, filename, mime_type, path, size_bytes, sha256, created_at)
       VALUES (?, ?, 'hero.png', 'image/png', ?, ?, ?, ?)`,
    ).run(imageId, owner.userId, relativePath, bytes.length, hash, new Date().toISOString());
    const canonical = `/images/${imageId}`;
    const content = [
      `![hero](${canonical})`,
      `![missing](/images/${missingId})`,
      `![noncanonical](${canonical}?unexpected=1)`,
      `[ordinary](${canonical})`,
      `\`![code](${canonical})\``,
    ].join("\n");
    const updatedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO notes (id, user_id, folder_id, title, content, created_at, updated_at)
       VALUES (?, ?, NULL, 'Transfer me', ?, ?, ?)`,
    ).run(noteId, owner.userId, content, updatedAt, updatedAt);
    db.prepare(
      `INSERT INTO note_revisions (
         id, note_id, title, content_gzip, type, content_sha256,
         uncompressed_bytes, compressed_bytes, created_at, actor_user_id, actor_kind
       ) VALUES (?, ?, 'Transfer me', ?, 'manual', 'hash', 1, 1, ?, ?, 'sync')`,
    ).run(uuidv4(), noteId, Buffer.from("x"), updatedAt, owner.userId);
    return { db, dbKey, noteId, imageId, missingId, canonical, content, updatedAt };
  }

  function createTransfer(source) {
    return request(app)
      .post("/space-transfers")
      .set(auth(owner))
      .send({
        sourceDbKey: source.dbKey,
        destinationDbKey: `space:${spaceId}`,
        sourceNoteId: source.noteId,
        destinationFolderId: null,
      });
  }

  it("copies and verifies canonical images, preserves warnings, then deletes only the source Document", async () => {
    const source = seedPersonalDocument();
    const response = await createTransfer(source).expect(201);

    expect(response.body.transfer).toMatchObject({
      status: "complete",
      revisionHistoryTransferred: false,
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: "SOURCE_IMAGE_MISSING", imageId: source.missingId }),
      ]),
    });
    expect(response.body.transfer.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NONCANONICAL_SOURCE_IMAGE", imageId: source.imageId }),
    ]));
    expect(source.db.prepare("SELECT 1 FROM notes WHERE id = ?").get(source.noteId)).toBeUndefined();
    // Revision history is backend-local and disappears with the deleted source
    // note; it is intentionally never copied to the destination database.
    const destination = getDb(`space:${spaceId}`);
    const copied = destination.prepare("SELECT content FROM notes WHERE id = ?")
      .get(response.body.transfer.destinationNoteId);
    expect(copied.content).toContain(`?space=${spaceId}`);
    expect(copied.content).toContain(`/images/${source.missingId}`);
    expect(copied.content).toContain(`[ordinary](${source.canonical})`);
    expect(copied.content).toContain(`![noncanonical](${source.canonical}?unexpected=1)`);
    expect(copied.content).toContain(`\`![code](${source.canonical})\``);
    const copiedImage = destination.prepare("SELECT * FROM images").get();
    const copiedPath = resolveStoredImagePath(`space:${spaceId}`, copiedImage.path);
    expect(fs.readFileSync(copiedPath)).toEqual(Buffer.from("verified-image-bytes"));
    expect(crypto.createHash("sha256").update(fs.readFileSync(copiedPath)).digest("hex"))
      .toBe(copiedImage.sha256);
    expect(destination.prepare("SELECT COUNT(*) AS count FROM note_revisions").get().count).toBe(0);
  });

  it("offers durable retry, keep-both, and verified delete-source recovery actions", async () => {
    const source = seedPersonalDocument();
    const created = await createTransfer(source).expect(201);
    const transferId = created.body.transfer.id;

    // Recreate the exact checkpointed source to model a crash after the
    // destination commit but before source deletion/checkpoint cleanup.
    source.db.prepare(
      `INSERT INTO notes (id, user_id, folder_id, title, content, created_at, updated_at)
       VALUES (?, ?, NULL, 'Transfer me', ?, ?, ?)`,
    ).run(source.noteId, owner.userId, source.content, source.updatedAt, source.updatedAt);
    getSpacesDb().prepare(
      "UPDATE space_transfers SET status = 'recoverable_duplicate', source_deleted_at = NULL WHERE id = ?",
    ).run(transferId);

    await request(app)
      .post(`/space-transfers/${transferId}/keep-both`)
      .set(auth(owner))
      .expect(200)
      .expect((response) => expect(response.body.transfer.status).toBe("kept_both"));
    expect(source.db.prepare("SELECT 1 FROM notes WHERE id = ?").get(source.noteId)).toBeTruthy();

    getSpacesDb().prepare(
      "UPDATE space_transfers SET status = 'recoverable_duplicate' WHERE id = ?",
    ).run(transferId);
    await request(app)
      .post(`/space-transfers/${transferId}/delete-source`)
      .set(auth(owner))
      .expect(200)
      .expect((response) => expect(response.body.transfer.status).toBe("complete"));
    expect(source.db.prepare("SELECT 1 FROM notes WHERE id = ?").get(source.noteId)).toBeUndefined();

    // Retrying the already completed checkpoint is idempotent.
    await request(app)
      .post(`/space-transfers/${transferId}/retry`)
      .set(auth(owner))
      .expect(200)
      .expect((response) => expect(response.body.transfer.status).toBe("complete"));
  });

  it("does not disclose a source or destination space to a non-member", async () => {
    const source = seedPersonalDocument();
    await request(app)
      .post("/space-transfers")
      .set(auth(outsider))
      .send({
        sourceDbKey: `user:${outsider.userId}`,
        destinationDbKey: `space:${spaceId}`,
        sourceNoteId: source.noteId,
      })
      .expect(404, { error: "Not found", code: "TRANSFER_NOT_FOUND" });
  });
});
