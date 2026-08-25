import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

// better-sqlite3 lives with the backend, not with this script. Resolve it from wherever it
// is actually reachable: next to the script, next to the process (in production this file is
// piped into `node` inside the api-service container, so cwd carries the dependency), or via
// the backend package in a repo checkout.
const moduleResolvers = [
  () => createRequire(import.meta.url),
  () => createRequire(path.join(process.cwd(), "package.json")),
  () => createRequire(new URL("../../backend/api-service/package.json", import.meta.url)),
];

let Database;
let lastResolveError;
for (const makeRequire of moduleResolvers) {
  try {
    Database = makeRequire()("better-sqlite3");
    break;
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    lastResolveError = error;
  }
}
if (!Database) {
  throw new Error("Could not resolve better-sqlite3 for the backup producer", {
    cause: lastResolveError,
  });
}

export const BACKUP_FORMAT = "panino-production-backup";
export const BACKUP_FORMAT_VERSION = 2;
export const BACKUP_MANIFEST_PATH = "panino-backup-manifest.json";
const TAR_BLOCK_SIZE = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function writeString(buffer, offset, length, value) {
  buffer.write(value, offset, length, "ascii");
}

function writeOctal(buffer, offset, length, value) {
  const encoded = Math.floor(value).toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) {
    throw new Error(`Tar field value ${value} exceeds ${length - 1} octal digits`);
  }
  writeString(buffer, offset, length, `${encoded}\0`);
}

/** Reject archive paths that could escape a restore staging directory. */
export function validateArchivePath(name) {
  if (
    typeof name !== "string" ||
    !name ||
    Buffer.byteLength(name, "utf8") > 100 ||
    !/^[\x20-\x7e]+$/.test(name) ||
    name.startsWith("/") ||
    name.includes("\\")
  ) {
    throw new Error(`Unsupported archive entry path: ${name}`);
  }
  const segments = name.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe archive entry path: ${name}`);
  }
  return name;
}

/** Create a POSIX ustar header for one regular file. */
export function createTarHeader(name, size, modifiedAtSeconds) {
  validateArchivePath(name);
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, modifiedAtSeconds);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "panino");
  writeString(header, 297, 32, "panino");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

export function parseDatabaseSelector(value) {
  if (!value) return null;
  const names = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.includes("/") || entry.includes("\\") || entry === "..") {
        throw new Error(`Database selector entries must be plain filenames: ${entry}`);
      }
      return entry.endsWith(".db") ? entry : `${entry}.db`;
    });
  return names.length > 0 ? new Set(names) : null;
}

function regularDatabaseNames(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
    .map((entry) => entry.name)
    .sort();
}

/** Return root and shared-space databases in the restore-contract order. */
export function listDatabaseEntries(dbDir, { include = null, exclude = null } = {}) {
  const rootNames = regularDatabaseNames(dbDir);
  const spacesDir = path.join(dbDir, "spaces");
  const spaceNames = regularDatabaseNames(spacesDir);
  const invalidSpaceNames = spaceNames.filter((name) => !UUID_PATTERN.test(name.slice(0, -3)));
  if (invalidSpaceNames.length > 0) {
    throw new Error(`Shared-space database names must be UUIDs: ${invalidSpaceNames.join(", ")}`);
  }

  const allNames = [...new Set([...rootNames, ...spaceNames])];
  if (include) {
    const missing = [...include].filter((name) => !allNames.includes(name));
    if (missing.length > 0) {
      throw new Error(`Requested database not found: ${missing.join(", ")}`);
    }
  }
  const selected = (name) => (!include || include.has(name)) && (!exclude || !exclude.has(name));
  const entries = [];
  if (rootNames.includes("_spaces.db") && selected("_spaces.db")) {
    entries.push({
      name: "_spaces.db",
      kind: "spaces-metadata",
      sourcePath: path.join(dbDir, "_spaces.db"),
      archivePath: "data/_spaces.db",
    });
  }
  for (const name of spaceNames.filter(selected)) {
    entries.push({
      name,
      kind: "space",
      spaceId: name.slice(0, -3).toLowerCase(),
      sourcePath: path.join(spacesDir, name),
      archivePath: `data/spaces/${name.toLowerCase()}`,
    });
  }
  for (const name of rootNames.filter((name) => !["_spaces.db", "_users.db"].includes(name) && selected(name))) {
    entries.push({
      name,
      kind: "user",
      sourcePath: path.join(dbDir, name),
      archivePath: `data/${name}`,
    });
  }
  if (rootNames.includes("_users.db") && selected("_users.db")) {
    entries.push({
      name: "_users.db",
      kind: "auth",
      sourcePath: path.join(dbDir, "_users.db"),
      archivePath: "data/_users.db",
    });
  }
  return entries;
}

/** Compatibility helper used by diagnostics and existing callers. */
export function listDatabaseFiles(dbDir, selection = {}) {
  return listDatabaseEntries(dbDir, selection).map((entry) =>
    entry.kind === "space" ? `spaces/${entry.name}` : entry.name,
  );
}

function listSpaceUploadEntries(uploadsDir, includedSpaceIds, { strict = false } = {}) {
  if (!strict && includedSpaceIds.size === 0) return [];
  const spacesRoot = path.join(uploadsDir, "spaces");
  if (!fs.existsSync(spacesRoot)) return [];
  const results = [];

  function visit(directory, relativeDirectory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const sourcePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to back up symbolic link: uploads/spaces/${relativePath}`);
      }
      if (entry.isDirectory()) {
        const [spaceId] = relativePath.split("/");
        if (!UUID_PATTERN.test(spaceId)) {
          throw new Error(`Shared-space upload directory must be a UUID: ${spaceId}`);
        }
        if (!relativeDirectory && !includedSpaceIds.has(spaceId.toLowerCase())) {
          if (strict) throw new Error(`Shared-space upload root has no database: ${spaceId}`);
          continue;
        }
        visit(sourcePath, relativePath);
      } else if (entry.isFile()) {
        const [spaceId] = relativePath.split("/");
        if (!UUID_PATTERN.test(spaceId)) {
          throw new Error(`Shared-space upload directory must be a UUID: ${spaceId}`);
        }
        if (includedSpaceIds.has(spaceId.toLowerCase())) {
          const archivePath = `uploads/spaces/${relativePath}`;
          validateArchivePath(archivePath);
          results.push({ sourcePath, archivePath, spaceId: spaceId.toLowerCase() });
        }
      } else {
        throw new Error(`Unsupported shared-space upload entry: ${relativePath}`);
      }
    }
  }

  visit(spacesRoot, "");
  return results.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
}

function databaseLabel(entry, indexes, totals) {
  if (entry.kind === "auth") return "authentication database";
  if (entry.kind === "spaces-metadata") return "shared-space metadata database";
  if (entry.kind === "space") {
    indexes.space += 1;
    return `shared-space database ${indexes.space}/${totals.space}`;
  }
  indexes.user += 1;
  return `user database ${indexes.user}/${totals.user}`;
}

export function createProgressReporter(output = process.stderr) {
  return ({ stage, label, percent, bytes }) => {
    const size = bytes === undefined ? "" : ` (${bytes.toLocaleString("en-US")} bytes)`;
    if (stage === "snapshot-start") output.write(`[backup] ${label}: creating online snapshot\n`);
    else if (stage === "snapshot-ready") output.write(`[backup] ${label}: snapshot ready${size}\n`);
    else if (stage === "transfer") output.write(`[transfer] ${label}: ${percent}%${size}\n`);
    else if (stage === "complete") output.write(`[backup] ${label}: complete\n`);
  };
}

async function* archiveRegularFile({ sourcePath, archivePath, label, reportProgress, manifestEntries }) {
  const before = fs.statSync(sourcePath);
  const hash = crypto.createHash("sha256");
  yield createTarHeader(archivePath, before.size, before.mtimeMs / 1000);
  let transferredBytes = 0;
  let reportedPercent = -1;
  for await (const chunk of fs.createReadStream(sourcePath)) {
    hash.update(chunk);
    yield chunk;
    transferredBytes += chunk.length;
    if (label && before.size > 0) {
      const percent = Math.min(100, Math.floor((transferredBytes / before.size) * 10) * 10);
      if (percent !== reportedPercent) {
        reportProgress({ stage: "transfer", label, percent, bytes: transferredBytes });
        reportedPercent = percent;
      }
    }
  }
  const after = fs.statSync(sourcePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`${label || "Backup source"} changed while being archived`);
  }
  const paddingLength = (TAR_BLOCK_SIZE - (before.size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
  if (paddingLength > 0) yield Buffer.alloc(paddingLength);
  manifestEntries.push({ path: archivePath, sizeBytes: before.size, sha256: hash.digest("hex") });
}

/** Yield a versioned tar archive containing databases plus shared-space uploads. */
export async function* createDatabaseTar(
  dbDir,
  snapshotRoot = "/dev/shm",
  reportProgress = () => {},
  selection = {},
  uploadsDir = path.resolve(dbDir, "../uploads"),
) {
  const databaseEntries = listDatabaseEntries(dbDir, selection);
  if (databaseEntries.length === 0) throw new Error(`No database files found in ${dbDir}`);
  const fullBackup = !selection.include && !selection.exclude;
  if (fullBackup && !databaseEntries.some((entry) => entry.kind === "spaces-metadata")) {
    throw new Error("Full backup requires data/_spaces.db");
  }
  if (fullBackup && !databaseEntries.some((entry) => entry.kind === "auth")) {
    throw new Error("Full backup requires data/_users.db");
  }

  const includedSpaceIds = new Set(databaseEntries.filter((entry) => entry.kind === "space").map((entry) => entry.spaceId));
  const uploadEntries = listSpaceUploadEntries(uploadsDir, includedSpaceIds, { strict: fullBackup });
  const manifestEntries = [];
  const createdAt = new Date().toISOString();
  const snapshotDir = fs.mkdtempSync(path.join(snapshotRoot, "panino-db-backup-"));
  const totals = {
    user: databaseEntries.filter((entry) => entry.kind === "user").length,
    space: databaseEntries.filter((entry) => entry.kind === "space").length,
  };
  const indexes = { user: 0, space: 0 };

  async function* archiveDatabase(entry) {
    const label = databaseLabel(entry, indexes, totals);
    const snapshotPath = path.join(snapshotDir, `${crypto.randomUUID()}.db`);
    reportProgress({ stage: "snapshot-start", label });
    const db = new Database(entry.sourcePath, { readonly: true, fileMustExist: true, timeout: 30_000 });
    try {
      const requiredBytes = db.pragma("page_count", { simple: true }) * db.pragma("page_size", { simple: true });
      const { bavail, bsize } = fs.statfsSync(snapshotDir);
      const availableBytes = bavail * bsize;
      if (requiredBytes > availableBytes) {
        throw new Error(`${snapshotRoot} has ${availableBytes} bytes available; ${label} needs at least ${requiredBytes} bytes`);
      }
      await db.backup(snapshotPath);
    } finally {
      db.close();
    }
    try {
      const stat = fs.statSync(snapshotPath);
      reportProgress({ stage: "snapshot-ready", label, bytes: stat.size });
      yield* archiveRegularFile({
        sourcePath: snapshotPath,
        archivePath: entry.archivePath,
        label,
        reportProgress,
        manifestEntries,
      });
      reportProgress({ stage: "complete", label });
    } finally {
      fs.rmSync(snapshotPath, { force: true });
    }
  }

  try {
    for (const entry of databaseEntries.filter((candidate) => ["spaces-metadata", "space"].includes(candidate.kind))) {
      yield* archiveDatabase(entry);
    }

    for (const [index, upload] of uploadEntries.entries()) {
      const label = `shared-space upload ${index + 1}/${uploadEntries.length}`;
      yield* archiveRegularFile({ ...upload, label, reportProgress, manifestEntries });
      reportProgress({ stage: "complete", label });
    }

    for (const entry of databaseEntries.filter((candidate) => ["user", "auth"].includes(candidate.kind))) {
      yield* archiveDatabase(entry);
    }

    const manifest = Buffer.from(`${JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      createdAt,
      scope: fullBackup ? "full" : "selected",
      spaces: [...includedSpaceIds].sort().map((spaceId) => ({
        spaceId,
        databasePath: `data/spaces/${spaceId}.db`,
        uploadsPrefix: `uploads/spaces/${spaceId}/`,
      })),
      entries: manifestEntries,
    }, null, 2)}\n`, "utf8");
    yield createTarHeader(BACKUP_MANIFEST_PATH, manifest.length, Date.parse(createdAt) / 1000);
    yield manifest;
    const manifestPadding = (TAR_BLOCK_SIZE - (manifest.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    if (manifestPadding > 0) yield Buffer.alloc(manifestPadding);
    yield Buffer.alloc(TAR_BLOCK_SIZE * 2);
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

export async function streamDatabaseBackup(dbDir, output = process.stdout) {
  const snapshotRoot = process.env.PANINO_BACKUP_TMP_DIR || "/dev/shm";
  const reportProgress = process.env.PANINO_BACKUP_PROGRESS === "1" ? createProgressReporter() : () => {};
  const selection = {
    include: parseDatabaseSelector(process.env.PANINO_BACKUP_INCLUDE),
    exclude: parseDatabaseSelector(process.env.PANINO_BACKUP_EXCLUDE),
  };
  const uploadsDir = process.env.UPLOADS_DIR || path.resolve(dbDir, "../uploads");
  await pipeline(
    Readable.from(createDatabaseTar(dbDir, snapshotRoot, reportProgress, selection, uploadsDir)),
    createGzip({ level: 6 }),
    output,
  );
}

export function describeDatabases(dbDir) {
  return listDatabaseEntries(dbDir).map((entry) => {
    const { size, mtime } = fs.statSync(entry.sourcePath);
    return {
      name: entry.kind === "space" ? `spaces/${entry.name}` : entry.name,
      sizeBytes: size,
      modifiedAt: new Date(mtime).toISOString(),
    };
  });
}

if (process.env.PANINO_STREAM_BACKUP_RUN === "1") {
  const dbDir = process.env.DB_DIR || "/app/backend/api-service/data";
  try {
    if (process.env.PANINO_BACKUP_LIST === "1") {
      process.stdout.write(`${JSON.stringify(describeDatabases(dbDir), null, 2)}\n`);
    } else {
      await streamDatabaseBackup(dbDir);
    }
  } catch (error) {
    console.error(`[database-backup] ${error.message}`);
    process.exitCode = 1;
  }
}
