import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { createDatabaseTar } from "../../../../scripts/production-database-backup/stream-database-backup.mjs";
import {
  stageProductionRestore,
  verifyArchiveChecksum,
  verifyStagedDirectory,
} from "../../../../scripts/production-database-backup/stage-production-restore.mjs";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "22222222-2222-4222-8222-222222222222";

async function collect(chunks) {
  const buffers = [];
  for await (const chunk of chunks) buffers.push(chunk);
  return Buffer.concat(buffers);
}

function createSource(root, { includeSpaceDatabase = true, includeUpload = true } = {}) {
  const dataDir = path.join(root, "source-data");
  const uploadsDir = path.join(root, "source-uploads");
  fs.mkdirSync(path.join(dataDir, "spaces"), { recursive: true });

  const authDb = new Database(path.join(dataDir, "_users.db"));
  authDb.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
  authDb.prepare("INSERT INTO users (id) VALUES (?)").run(OWNER_ID);
  authDb.close();

  const spacesDb = new Database(path.join(dataDir, "_spaces.db"));
  spacesDb.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      delete_after TEXT
    );
    CREATE TABLE space_members (
      space_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL
    );
    CREATE TABLE space_invites (
      token_hash TEXT PRIMARY KEY,
      space_id TEXT NOT NULL
    );
    CREATE TABLE space_user_versions (
      user_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    );
  `);
  spacesDb.prepare(
    "INSERT INTO spaces (id, owner_user_id, status, delete_after) VALUES (?, ?, 'active', NULL)",
  ).run(SPACE_ID, OWNER_ID);
  spacesDb.prepare(
    "INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'owner')",
  ).run(SPACE_ID, OWNER_ID);
  spacesDb.prepare(
    "INSERT INTO space_user_versions (user_id, version) VALUES (?, 1)",
  ).run(OWNER_ID);
  spacesDb.close();

  if (includeSpaceDatabase) {
    const contentDb = new Database(path.join(dataDir, "spaces", `${SPACE_ID}.db`));
    contentDb.exec(`
      CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT);
      CREATE TABLE images (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL
      );
    `);
    contentDb.prepare("INSERT INTO notes VALUES (?, ?)").run("note-A", "restored");
    const imageBytes = Buffer.from("restored image bytes");
    contentDb.prepare("INSERT INTO images VALUES (?, ?, ?, ?)").run(
      "image-A",
      "image-A.png",
      imageBytes.length,
      crypto.createHash("sha256").update(imageBytes).digest("hex"),
    );
    contentDb.close();
  }

  const uploadRoot = path.join(uploadsDir, "spaces", SPACE_ID);
  if (includeSpaceDatabase || includeUpload) {
    fs.mkdirSync(uploadRoot, { recursive: true });
  }
  if (includeUpload) {
    fs.writeFileSync(path.join(uploadRoot, "image-A.png"), "restored image bytes");
  }
  return { dataDir, uploadsDir };
}

async function writeArchive(root, source) {
  const rawTar = await collect(
    createDatabaseTar(source.dataDir, root, () => {}, {}, source.uploadsDir),
  );
  const archivePath = path.join(root, "backup.tar.gz");
  const archive = gzipSync(rawTar);
  fs.writeFileSync(archivePath, archive);
  const checksum = crypto.createHash("sha256").update(archive).digest("hex");
  fs.writeFileSync(`${archivePath}.sha256`, `${checksum}  ${path.basename(archivePath)}\n`);
  return archivePath;
}

describe("production restore staging", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "panino-production-restore-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("stages one all-or-nothing space set after checksum, hash, SQLite, and invariant validation", async () => {
    const source = createSource(tempDir);
    const archivePath = await writeArchive(tempDir, source);
    const stagingDir = path.join(tempDir, "validated-stage");

    const result = await stageProductionRestore({ archivePath, stagingDir });

    expect(result).toMatchObject({ stagingDir, spaces: 1 });
    await expect(verifyStagedDirectory(stagingDir)).resolves.toMatchObject({ spaces: 1 });
    expect(fs.readFileSync(
      path.join(stagingDir, "uploads", "spaces", SPACE_ID, "image-A.png"),
      "utf8",
    )).toBe("restored image bytes");
    const restored = new Database(path.join(stagingDir, "data", "spaces", `${SPACE_ID}.db`), {
      readonly: true,
    });
    expect(restored.prepare("SELECT content FROM notes WHERE id = 'note-A'").pluck().get()).toBe("restored");
    restored.close();
  });

  it("rejects a checksum mismatch before creating a staging target", async () => {
    const archivePath = await writeArchive(tempDir, createSource(tempDir));
    fs.writeFileSync(`${archivePath}.sha256`, `${"0".repeat(64)}  backup.tar.gz\n`);
    const stagingDir = path.join(tempDir, "never-created");

    await expect(stageProductionRestore({ archivePath, stagingDir })).rejects.toThrow(/checksum mismatch/i);
    expect(fs.existsSync(stagingDir)).toBe(false);
  });

  it("rejects metadata that advertises a space without its database", async () => {
    const archivePath = await writeArchive(
      tempDir,
      createSource(tempDir, { includeSpaceDatabase: false, includeUpload: false }),
    );
    const stagingDir = path.join(tempDir, "invalid-stage");

    await expect(stageProductionRestore({ archivePath, stagingDir })).rejects.toThrow(
      /metadata and archived space databases do not match/,
    );
    expect(fs.existsSync(stagingDir)).toBe(false);
  });

  it("rejects a space database whose referenced image bytes are absent", async () => {
    const archivePath = await writeArchive(
      tempDir,
      createSource(tempDir, { includeUpload: false }),
    );
    const stagingDir = path.join(tempDir, "missing-image-stage");

    await expect(stageProductionRestore({ archivePath, stagingDir })).rejects.toThrow(
      /missing referenced image bytes/,
    );
    expect(fs.existsSync(stagingDir)).toBe(false);
  });

  it("requires a checksum file that names the selected archive", async () => {
    const archivePath = await writeArchive(tempDir, createSource(tempDir));
    fs.writeFileSync(`${archivePath}.sha256`, `${"0".repeat(64)}  another.tar.gz\n`);

    await expect(verifyArchiveChecksum(archivePath)).rejects.toThrow(/does not name/);
  });
});
