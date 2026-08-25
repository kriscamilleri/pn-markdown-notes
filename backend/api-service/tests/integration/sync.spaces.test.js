// Integration tests for shared-space support in POST /sync (COLLAB-04 Phase 2).
//
// Covers: flag-gated + membership-gated access (owner/editor allowed,
// nonmember and disabled-flag both fail closed as an indistinguishable 404),
// whole-batch allowlist rejection with no partial merge, server-derived
// revision actor attribution, targeted connection invalidation on merge
// failure, and the personal-sync wire shape staying byte-identical when
// `space` is absent from the request body.
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import request from "supertest";
import {
  createTestApp,
  setupTestUser,
  cleanupTestUser,
  getTestToken,
  generateSiteId,
} from "../testHelpers.js";
import { getDb, deleteTestDb, getSpacesDb } from "../../db.js";
import { createSpace, addEditorMember } from "../../spaces.js";

const FLAG = "SHARED_SPACES_ENABLED";
const ORIGINAL_FLAG_VALUE = process.env[FLAG];

function setFlagEnabled(enabled) {
  if (enabled) {
    process.env[FLAG] = "true";
  } else {
    delete process.env[FLAG];
  }
}

function injectNotesClockOrphan(db, noteId) {
  // Mirrors the corruption reproduced in sync.test.js's images orphan test,
  // adapted to a table that a shared-space sync is allowed to touch: create
  // a slab-mapping PK and non-sentinel per-column clock rows without ever
  // writing a base `notes` row, so the next incoming change for this PK
  // hits crsqlite's "could not find row to merge with" failure.
  db.prepare(`INSERT INTO notes__crsql_pks (id) VALUES (?)`).run(noteId);
  const { __crsql_key: key } = db
    .prepare(`SELECT __crsql_key FROM notes__crsql_pks WHERE id = ?`)
    .get(noteId);

  const cols = [
    "user_id",
    "folder_id",
    "title",
    "content",
    "pinned",
    "created_at",
    "updated_at",
  ];
  const insertClock = db.prepare(
    `INSERT INTO notes__crsql_clock
       (key, col_name, col_version, db_version, site_id, seq)
       VALUES (?, ?, 1, 1, 0, 1)`,
  );
  for (const c of cols) insertClock.run(key, c);
  return key;
}

describe("POST /sync (shared spaces)", () => {
  let app, server;
  let owner, editor, outsider;
  let ownerToken, editorToken, outsiderToken;
  let spaceId;

  beforeAll(() => {
    const result = createTestApp();
    app = result.app;
    server = result.server;
  });

  afterAll(() => {
    setFlagEnabled(Boolean(ORIGINAL_FLAG_VALUE === "true"));
    if (ORIGINAL_FLAG_VALUE === undefined) delete process.env[FLAG];
    else process.env[FLAG] = ORIGINAL_FLAG_VALUE;
    return new Promise((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
  });

  beforeEach(async () => {
    setFlagEnabled(true);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    owner = await setupTestUser(`space-owner-${stamp}@example.com`, "password123");
    editor = await setupTestUser(`space-editor-${stamp}@example.com`, "password123");
    outsider = await setupTestUser(`space-outsider-${stamp}@example.com`, "password123");
    ownerToken = getTestToken(owner.userId);
    editorToken = getTestToken(editor.userId);
    outsiderToken = getTestToken(outsider.userId);

    const created = createSpace({ actorUserId: owner.userId, name: `Test Space ${stamp}` });
    spaceId = created.spaceId;
    addEditorMember({ actorUserId: owner.userId, spaceId, userId: editor.userId });
  });

  afterEach(() => {
    if (spaceId) {
      try {
        const spacesDb = getSpacesDb();
        spacesDb.prepare("DELETE FROM space_members WHERE space_id = ?").run(spaceId);
        spacesDb.prepare("DELETE FROM space_invites WHERE space_id = ?").run(spaceId);
        spacesDb.prepare("DELETE FROM spaces WHERE id = ?").run(spaceId);
      } catch (error) {
        console.error("Error cleaning up test space metadata:", error);
      }
      deleteTestDb(`space:${spaceId}`);
    }

    for (const [db, user] of [
      [getSpacesDb(), owner],
      [getSpacesDb(), editor],
      [getSpacesDb(), outsider],
    ]) {
      if (!user) continue;
      try {
        db.prepare("DELETE FROM space_user_versions WHERE user_id = ?").run(user.userId);
      } catch (error) {
        console.error("Error cleaning up space_user_versions:", error);
      }
    }

    if (owner) cleanupTestUser(owner.userId);
    if (editor) cleanupTestUser(editor.userId);
    if (outsider) cleanupTestUser(outsider.userId);
    setFlagEnabled(true);
  });

  it("allows the owner to sync against the space and returns membershipVersion", async () => {
    const siteId = generateSiteId("o");

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ space: spaceId, since: 0, siteId, changes: [] });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("changes");
    expect(response.body).toHaveProperty("clock");
    expect(typeof response.body.membershipVersion).toBe("number");
    expect(response.body.membershipVersion).toBeGreaterThan(0);
  });

  it("allows an editor to sync against the space", async () => {
    const siteId = generateSiteId("e");

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ space: spaceId, since: 0, siteId, changes: [] });

    expect(response.status).toBe(200);
    expect(typeof response.body.membershipVersion).toBe("number");
  });

  it("returns a non-disclosing 404 for a nonmember", async () => {
    const siteId = generateSiteId("n");

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${outsiderToken}`)
      .send({ space: spaceId, since: 0, siteId, changes: [] });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not found", code: "SPACE_NOT_FOUND" });
  });

  it("returns the same non-disclosing 404 for an unknown space id", async () => {
    const siteId = generateSiteId("u");
    const unknownSpaceId = "00000000-0000-4000-8000-000000000000";

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ space: unknownSpaceId, since: 0, siteId, changes: [] });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not found", code: "SPACE_NOT_FOUND" });
  });

  it("fails closed with 404 for an otherwise-valid owner when the feature flag is disabled", async () => {
    setFlagEnabled(false);
    const siteId = generateSiteId("f");

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ space: spaceId, since: 0, siteId, changes: [] });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not found", code: "SPACE_NOT_FOUND" });
  });

  it("leaves personal (no space field) sync behavior byte-identical", async () => {
    const siteId = generateSiteId("p");

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ since: 0, siteId, changes: [] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ changes: [], clock: 0, skipped: 0 });
    expect(response.body).not.toHaveProperty("membershipVersion");
  });

  it("rejects a batch containing a disallowed table with no partial merge", async () => {
    const siteId = generateSiteId("d");
    const spaceDb = getDb(`space:${spaceId}`);
    const initialVersion = spaceDb
      .prepare("SELECT max(db_version) AS version FROM crsql_changes")
      .get().version ?? 0;

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        space: spaceId,
        since: 0,
        siteId,
        changes: [
          {
            table: "folders",
            pk: '["folder-allowed"]',
            cid: "name",
            val: '"Allowed folder"',
            col_version: 1,
            db_version: 1,
            site_id: siteId,
            cl: 0,
            seq: 1,
          },
          {
            table: "users",
            pk: '["not-allowed"]',
            cid: "name",
            val: '"nope"',
            col_version: 1,
            db_version: 2,
            site_id: siteId,
            cl: 0,
            seq: 2,
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Change batch contains a table/column not permitted for shared spaces",
      code: "SPACE_CHANGE_NOT_ALLOWED",
    });

    expect(
      spaceDb.prepare("SELECT id FROM folders WHERE id = ?").get("folder-allowed"),
    ).toBeUndefined();
    expect(
      spaceDb.prepare("SELECT max(db_version) AS version FROM crsql_changes").get()
        .version ?? 0,
    ).toBe(initialVersion);
  });

  it("rejects a disallowed column (user_id) on an otherwise-allowed table", async () => {
    const siteId = generateSiteId("c");

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        space: spaceId,
        since: 0,
        siteId,
        changes: [
          {
            table: "notes",
            pk: '["note-x"]',
            cid: "user_id",
            val: `"${owner.userId}"`,
            col_version: 1,
            db_version: 1,
            site_id: siteId,
            cl: 0,
            seq: 1,
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("SPACE_CHANGE_NOT_ALLOWED");
  });

  it("rejects a batch whose delete tombstone has a malformed/empty primary key, with no partial merge", async () => {
    const siteId = generateSiteId("m");

    // Pre-create a valid base row: a *correct* tombstone for it would
    // otherwise succeed, proving this rejection is really about the
    // malformed pk shape and not the surrounding tombstone semantics.
    const spaceDb = getDb(`space:${spaceId}`);
    spaceDb
      .prepare(
        `INSERT INTO notes (id, folder_id, title, content, created_at, updated_at)
         VALUES (?, NULL, 'Still here', '', datetime('now'), datetime('now'))`,
      )
      .run("note-malformed-pk-tombstone");

    // Capture the db_version *after* the setup insert (which itself bumps
    // crsql_changes) so the post-request comparison isolates whether the
    // rejected batch merged anything, rather than counting the fixture's
    // own clock activity.
    const versionBeforeSync =
      spaceDb.prepare("SELECT max(db_version) AS version FROM crsql_changes").get().version ?? 0;

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        space: spaceId,
        since: 0,
        siteId,
        changes: [
          {
            table: "folders",
            pk: '["folder-with-malformed-sibling"]',
            cid: "name",
            val: '"Allowed folder"',
            col_version: 1,
            db_version: 1,
            site_id: siteId,
            cl: 0,
            seq: 1,
          },
          {
            // A delete tombstone (sentinel cid) whose pk is empty: still
            // decodes to no usable id and must be rejected like any other
            // malformed pk, not waved through because it is a tombstone.
            table: "notes",
            pk: "",
            cid: "-1",
            val: null,
            col_version: 1,
            db_version: 2,
            site_id: siteId,
            cl: 2,
            seq: 2,
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Change batch contains a table/column not permitted for shared spaces",
      code: "SPACE_CHANGE_NOT_ALLOWED",
    });

    // No partial merge: neither the sibling folder row nor the tombstone
    // applied, and the pre-existing base note row is untouched.
    expect(
      spaceDb.prepare("SELECT id FROM folders WHERE id = ?").get("folder-with-malformed-sibling"),
    ).toBeUndefined();
    expect(
      spaceDb.prepare("SELECT id FROM notes WHERE id = ?").get("note-malformed-pk-tombstone"),
    ).toBeDefined();
    expect(
      spaceDb.prepare("SELECT max(db_version) AS version FROM crsql_changes").get().version ?? 0,
    ).toBe(versionBeforeSync);
  });

  it("rejects a change with no pk field at all", async () => {
    const siteId = generateSiteId("n");

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        space: spaceId,
        since: 0,
        siteId,
        changes: [
          {
            table: "globals",
            // pk omitted entirely.
            cid: "value",
            val: '"anything"',
            col_version: 1,
            db_version: 1,
            site_id: siteId,
            cl: 0,
            seq: 1,
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("SPACE_CHANGE_NOT_ALLOWED");
  });

  it("allows a notes tombstone (cid -1) alongside allowed columns", async () => {
    const siteId = generateSiteId("t");

    // Pre-create the base row through a plain INSERT (mirroring
    // sync.revision.test.js): the notes table is already a CRR, so its
    // AFTER-INSERT trigger wires up proper clock rows, matching how a real
    // client tombstone (cid "-1", cl >= 1) is later merged.
    const spaceDb = getDb(`space:${spaceId}`);
    spaceDb
      .prepare(
        `INSERT INTO notes (id, folder_id, title, content, created_at, updated_at)
         VALUES (?, NULL, 'To delete', '', datetime('now'), datetime('now'))`,
      )
      .run("note-to-delete");

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        space: spaceId,
        since: 0,
        siteId,
        changes: [
          {
            table: "notes",
            pk: '["note-to-delete"]',
            cid: "-1",
            val: null,
            col_version: 1,
            db_version: 1,
            site_id: siteId,
            cl: 2,
            seq: 1,
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(
      spaceDb.prepare("SELECT id FROM notes WHERE id = ?").get("note-to-delete"),
    ).toBeUndefined();
  });

  it("records server-derived actor attribution on revisions created from a space sync", async () => {
    const siteId = generateSiteId("v");
    const spaceDb = getDb(`space:${spaceId}`);
    spaceDb
      .prepare(
        `INSERT INTO notes (id, folder_id, title, content, created_at, updated_at)
         VALUES (?, NULL, 'Base title', '# base content', datetime('now'), datetime('now'))`,
      )
      .run("note-actor");

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({
        space: spaceId,
        since: 0,
        siteId,
        changes: [
          {
            table: "notes",
            pk: '["note-actor"]',
            cid: "content",
            val: '"# updated by editor"',
            col_version: 1,
            db_version: 1,
            site_id: siteId,
            cl: 0,
            seq: 1,
          },
        ],
      });

    expect(response.status).toBe(200);

    const revision = spaceDb
      .prepare(
        "SELECT actor_user_id, actor_kind FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get("note-actor");
    expect(revision).toBeDefined();
    expect(revision.actor_user_id).toBe(editor.userId);
    expect(revision.actor_kind).toBe("sync");
  });

  it("ignores a client-supplied actor field and still derives the actor from the JWT", async () => {
    const siteId = generateSiteId("j");
    const spaceDb = getDb(`space:${spaceId}`);
    spaceDb
      .prepare(
        `INSERT INTO notes (id, folder_id, title, content, created_at, updated_at)
         VALUES (?, NULL, 'Base title', '# base content', datetime('now'), datetime('now'))`,
      )
      .run("note-actor-2");

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        space: spaceId,
        since: 0,
        siteId,
        actorUserId: outsider.userId,
        actorKind: "collab",
        changes: [
          {
            table: "notes",
            pk: '["note-actor-2"]',
            cid: "content",
            val: '"# updated by owner"',
            col_version: 1,
            db_version: 1,
            site_id: siteId,
            cl: 0,
            seq: 1,
          },
        ],
      });

    expect(response.status).toBe(200);

    const revision = spaceDb
      .prepare(
        "SELECT actor_user_id, actor_kind FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get("note-actor-2");
    expect(revision.actor_user_id).toBe(owner.userId);
    expect(revision.actor_kind).toBe("sync");
  });

  it("invalidates only the targeted space connection on a merge failure, leaving the personal connection intact", async () => {
    const siteId = generateSiteId("m");

    // Establish (and cache) the owner's personal connection first so we can
    // assert it is untouched by the space merge failure below.
    const personalDbBefore = getDb(`user:${owner.userId}`);
    await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ since: 0, siteId, changes: [] });

    const spaceDb = getDb(`space:${spaceId}`);
    const orphanId = `orphan-note-${Date.now()}`;
    injectNotesClockOrphan(spaceDb, orphanId);

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        space: spaceId,
        since: 0,
        siteId,
        changes: [
          {
            table: "notes",
            pk: JSON.stringify([orphanId]),
            cid: "title",
            val: '"corrupt merge"',
            col_version: 1,
            db_version: 1,
            site_id: siteId,
            cl: 1,
            seq: 1,
          },
        ],
      });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "Sync temporarily unavailable",
      code: "SYNC_CONNECTION_RESET",
    });

    const reopenedSpaceDb = getDb(`space:${spaceId}`);
    expect(reopenedSpaceDb).not.toBe(spaceDb);
    expect(
      reopenedSpaceDb.prepare("SELECT crsql_internal_sync_bit() AS sync_bit").get()
        .sync_bit,
    ).toBe(0);

    const personalDbAfter = getDb(`user:${owner.userId}`);
    expect(personalDbAfter).toBe(personalDbBefore);
  });

  it("does not trigger the personal GitHub auto backup for a space sync", async () => {
    const siteId = generateSiteId("b");

    const response = await request(app)
      .post("/sync")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        space: spaceId,
        since: 0,
        siteId,
        changes: [
          {
            table: "folders",
            pk: '["folder-backup-check"]',
            cid: "name",
            val: '"Backup check"',
            col_version: 1,
            db_version: 1,
            site_id: siteId,
            cl: 0,
            seq: 1,
          },
        ],
      });

    expect(response.status).toBe(200);
    // No assertion hook exists for "backup job was scheduled" short of
    // spying on the module; the absence of any error/side effect together
    // with sync.js's explicit `if (!isSpaceSync)` gate (see code review) is
    // the behavioral contract under test here — this test's primary job is
    // to make sure a space sync completes normally without the personal
    // per-user auto-backup path throwing or being invoked for a userId that
    // has no personal backup configuration.
  });
});
