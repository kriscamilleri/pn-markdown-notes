import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  BACKUP_MANIFEST_PATH,
  createTarHeader,
  createProgressReporter,
  createDatabaseTar,
  listDatabaseFiles,
  parseDatabaseSelector,
  describeDatabases,
} from "../../../../scripts/production-database-backup/stream-database-backup.mjs";

const TAR_BLOCK_SIZE = 512;

function parseTar(buffer) {
  const entries = new Map();
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;

    const name = header
      .subarray(0, 100)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const sizeText = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0.*$/, "")
      .trim();
    const size = Number.parseInt(sizeText, 8);
    const dataOffset = offset + TAR_BLOCK_SIZE;
    entries.set(name, buffer.subarray(dataOffset, dataOffset + size));
    offset =
      dataOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  return entries;
}

async function collect(chunks) {
  const buffers = [];
  for await (const chunk of chunks) buffers.push(chunk);
  return Buffer.concat(buffers);
}

describe("stream database backup", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "panino-db-backup-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("targets the production Compose volume mount paths", () => {
    const backupScript = fs.readFileSync(
      new URL("../../../../scripts/production-database-backup/backup-production-databases.sh", import.meta.url),
      "utf8",
    );
    const compose = fs.readFileSync(new URL("../../../../docker-compose.yml", import.meta.url), "utf8");

    expect(compose).toContain("api-data:/app/backend/api-service/data");
    expect(compose).toContain("uploads-data:/app/backend/api-service/uploads");
    expect(backupScript).toContain("DB_DIR=/app/backend/api-service/data");
    expect(backupScript).toContain("UPLOADS_DIR=/app/backend/api-service/uploads");
    expect(backupScript).not.toContain("DB_DIR=/app/data");
  });

  it("lists only regular .db files in stable order", () => {
    fs.writeFileSync(path.join(tempDir, "z.db"), "");
    fs.writeFileSync(path.join(tempDir, "_users.db"), "");
    fs.writeFileSync(path.join(tempDir, "_spaces.db"), "");
    fs.writeFileSync(path.join(tempDir, "z.db-wal"), "");
    fs.mkdirSync(path.join(tempDir, "directory.db"));
    const spacesDir = path.join(tempDir, "spaces");
    fs.mkdirSync(spacesDir);
    fs.writeFileSync(
      path.join(spacesDir, "11111111-1111-4111-8111-111111111111.db"),
      "",
    );

    expect(listDatabaseFiles(tempDir)).toEqual([
      "_spaces.db",
      "spaces/11111111-1111-4111-8111-111111111111.db",
      "z.db",
      "_users.db",
    ]);
  });

  it("rejects unsafe nested tar paths", () => {
    expect(() => createTarHeader("../data/_users.db", 0, 0)).toThrow(/Unsafe/);
    expect(() => createTarHeader("/data/_users.db", 0, 0)).toThrow(/Unsupported/);
    expect(() => createTarHeader("data\\_users.db", 0, 0)).toThrow(/Unsupported/);
  });

  // Selection exists so a narrow diagnostic pull (DX-10 step 8) does not copy the whole
  // estate — including the auth database — onto a workstation.
  describe("database selection", () => {
    beforeEach(() => {
      for (const name of ["_spaces.db", "_users.db", "user-a.db", "user-b.db"]) {
        fs.writeFileSync(path.join(tempDir, name), "");
      }
    });

    it("takes every database when no selection is given", () => {
      expect(listDatabaseFiles(tempDir)).toEqual([
        "_spaces.db",
        "user-a.db",
        "user-b.db",
        "_users.db",
      ]);
    });

    it("includes only the requested databases", () => {
      const include = parseDatabaseSelector("user-b");
      expect(listDatabaseFiles(tempDir, { include })).toEqual(["user-b.db"]);
    });

    it("excludes the auth database when asked", () => {
      const exclude = parseDatabaseSelector("_users.db");
      expect(listDatabaseFiles(tempDir, { exclude })).toEqual([
        "_spaces.db",
        "user-a.db",
        "user-b.db",
      ]);
    });

    it("applies exclude after include", () => {
      const include = parseDatabaseSelector("user-a,_users.db");
      const exclude = parseDatabaseSelector("_users.db");
      expect(listDatabaseFiles(tempDir, { include, exclude })).toEqual([
        "user-a.db",
      ]);
    });

    it("treats the .db suffix as optional and trims whitespace", () => {
      expect(parseDatabaseSelector(" user-a , user-b.db ")).toEqual(
        new Set(["user-a.db", "user-b.db"]),
      );
    });

    it("returns null for an empty or missing selector", () => {
      expect(parseDatabaseSelector("")).toBeNull();
      expect(parseDatabaseSelector(undefined)).toBeNull();
      expect(parseDatabaseSelector(" , ")).toBeNull();
    });

    it("rejects selector entries containing path separators", () => {
      expect(() => parseDatabaseSelector("../../etc/passwd")).toThrow(
        /plain filenames/,
      );
      expect(() => parseDatabaseSelector("sub\\dir")).toThrow(/plain filenames/);
      expect(() => parseDatabaseSelector("..")).toThrow(/plain filenames/);
    });

    it("describes databases with metadata only, no content", () => {
      const described = describeDatabases(tempDir);
      expect(described.map((entry) => entry.name)).toEqual([
        "_spaces.db",
        "user-a.db",
        "user-b.db",
        "_users.db",
      ]);
      for (const entry of described) {
        expect(entry).toHaveProperty("sizeBytes");
        expect(entry).toHaveProperty("modifiedAt");
        // Metadata only — a description must never carry database bytes.
        expect(Object.keys(entry).sort()).toEqual([
          "modifiedAt",
          "name",
          "sizeBytes",
        ]);
      }
    });

    it("fails loudly when a requested database does not exist", () => {
      const include = parseDatabaseSelector("no-such-user");
      expect(() => listDatabaseFiles(tempDir, { include })).toThrow(
        /Requested database not found: no-such-user\.db/,
      );
    });
  });

  it("archives valid snapshots including committed WAL changes", async () => {
    const spacesDb = new Database(path.join(tempDir, "_spaces.db"));
    spacesDb.exec("CREATE TABLE spaces (id TEXT PRIMARY KEY)");
    spacesDb.close();

    const authDb = new Database(path.join(tempDir, "_users.db"));
    authDb.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    authDb.prepare("INSERT INTO users (id) VALUES (?)").run("user-A");
    authDb.close();

    const userDb = new Database(path.join(tempDir, "user-A.db"));
    userDb.pragma("journal_mode = WAL");
    userDb.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT)");
    userDb
      .prepare("INSERT INTO notes (id, title) VALUES (?, ?)")
      .run("note-A", "Committed in WAL");

    expect(fs.existsSync(path.join(tempDir, "user-A.db-wal"))).toBe(true);

    const archive = await collect(createDatabaseTar(tempDir, tempDir));
    const entries = parseTar(archive);
    expect([...entries.keys()]).toEqual([
      "data/_spaces.db",
      "data/user-A.db",
      "data/_users.db",
      BACKUP_MANIFEST_PATH,
    ]);

    const authSnapshotPath = path.join(tempDir, "restored-auth.db");
    fs.writeFileSync(authSnapshotPath, entries.get("data/_users.db"));
    const authSnapshot = new Database(authSnapshotPath);
    expect(authSnapshot.prepare("SELECT id FROM users").pluck().all()).toEqual([
      "user-A",
    ]);
    authSnapshot.close();

    const userSnapshotPath = path.join(tempDir, "restored-user.db");
    fs.writeFileSync(userSnapshotPath, entries.get("data/user-A.db"));
    const userSnapshot = new Database(userSnapshotPath);
    expect(
      userSnapshot
        .prepare("SELECT id, title FROM notes")
        .get(),
    ).toEqual({ id: "note-A", title: "Committed in WAL" });
    userSnapshot.close();
    userDb.close();
  });

  it("archives shared-space databases and uploads with a hashed path manifest", async () => {
    const spaceId = "11111111-1111-4111-8111-111111111111";
    const spacesDb = new Database(path.join(tempDir, "_spaces.db"));
    spacesDb.exec("CREATE TABLE spaces (id TEXT PRIMARY KEY)");
    spacesDb.close();
    const authDb = new Database(path.join(tempDir, "_users.db"));
    authDb.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    authDb.close();
    fs.mkdirSync(path.join(tempDir, "spaces"));
    const contentDb = new Database(path.join(tempDir, "spaces", `${spaceId}.db`));
    contentDb.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT)");
    contentDb.close();

    const uploadsDir = path.join(tempDir, "uploads-root");
    const uploadRoot = path.join(uploadsDir, "spaces", spaceId);
    fs.mkdirSync(uploadRoot, { recursive: true });
    fs.writeFileSync(path.join(uploadRoot, "asset.png"), "image bytes");

    const archive = await collect(
      createDatabaseTar(tempDir, tempDir, () => {}, {}, uploadsDir),
    );
    const entries = parseTar(archive);
    expect([...entries.keys()]).toEqual([
      "data/_spaces.db",
      `data/spaces/${spaceId}.db`,
      `uploads/spaces/${spaceId}/asset.png`,
      "data/_users.db",
      BACKUP_MANIFEST_PATH,
    ]);

    const manifest = JSON.parse(entries.get(BACKUP_MANIFEST_PATH).toString("utf8"));
    expect(manifest).toMatchObject({
      format: "panino-production-backup",
      version: 2,
      scope: "full",
      spaces: [{
        spaceId,
        databasePath: `data/spaces/${spaceId}.db`,
        uploadsPrefix: `uploads/spaces/${spaceId}/`,
      }],
    });
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "data/_spaces.db",
      `data/spaces/${spaceId}.db`,
      `uploads/spaces/${spaceId}/asset.png`,
      "data/_users.db",
    ]);
    expect(manifest.entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
  });

  it("refuses symbolic links in shared-space uploads", async () => {
    const spaceId = "11111111-1111-4111-8111-111111111111";
    for (const name of ["_spaces.db", "_users.db"]) {
      const db = new Database(path.join(tempDir, name));
      db.exec("CREATE TABLE marker (id TEXT PRIMARY KEY)");
      db.close();
    }
    fs.mkdirSync(path.join(tempDir, "spaces"));
    const contentDb = new Database(path.join(tempDir, "spaces", `${spaceId}.db`));
    contentDb.exec("CREATE TABLE notes (id TEXT PRIMARY KEY)");
    contentDb.close();
    const uploadRoot = path.join(tempDir, "uploads", "spaces", spaceId);
    fs.mkdirSync(uploadRoot, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "outside.png"), "outside");
    fs.symlinkSync(path.join(tempDir, "outside.png"), path.join(uploadRoot, "linked.png"));

    await expect(collect(
      createDatabaseTar(tempDir, tempDir, () => {}, {}, path.join(tempDir, "uploads")),
    )).rejects.toThrow(/symbolic link/);
  });

  it("refuses an upload root without its shared-space database", async () => {
    const orphanSpaceId = "33333333-3333-4333-8333-333333333333";
    for (const name of ["_spaces.db", "_users.db"]) {
      const db = new Database(path.join(tempDir, name));
      db.exec("CREATE TABLE marker (id TEXT PRIMARY KEY)");
      db.close();
    }
    const uploadsDir = path.join(tempDir, "uploads");
    fs.mkdirSync(path.join(uploadsDir, "spaces", orphanSpaceId), { recursive: true });

    await expect(collect(
      createDatabaseTar(tempDir, tempDir, () => {}, {}, uploadsDir),
    )).rejects.toThrow(/upload root has no database/);
  });

  it("fails before writing an archive when no databases exist", async () => {
    await expect(collect(createDatabaseTar(tempDir, tempDir))).rejects.toThrow(
      `No database files found in ${tempDir}`,
    );
  });

  it("reports per-database progress without user database filenames", async () => {
    const spacesDb = new Database(path.join(tempDir, "_spaces.db"));
    spacesDb.exec("CREATE TABLE spaces (id TEXT PRIMARY KEY)");
    spacesDb.close();
    const authDb = new Database(path.join(tempDir, "_users.db"));
    authDb.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    authDb.close();

    const db = new Database(path.join(tempDir, "sensitive-user-id.db"));
    db.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)");
    db.prepare("INSERT INTO notes VALUES (?, ?)").run("note-A", "content");
    db.close();

    let progressOutput = "";
    const reportProgress = createProgressReporter({
      write(chunk) {
        progressOutput += chunk;
      },
    });

    await collect(createDatabaseTar(tempDir, tempDir, reportProgress));

    expect(progressOutput).toContain(
      "[backup] user database 1/1: creating online snapshot",
    );
    expect(progressOutput).toMatch(
      /\[backup\] user database 1\/1: snapshot ready \([\d,]+ bytes\)/,
    );
    expect(progressOutput).toMatch(
      /\[transfer\] user database 1\/1: 100% \([\d,]+ bytes\)/,
    );
    expect(progressOutput).toContain("[backup] user database 1/1: complete");
    expect(progressOutput).not.toContain("sensitive-user-id");
  });
});
