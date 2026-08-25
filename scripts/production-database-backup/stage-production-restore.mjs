#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_MANIFEST_PATH,
  validateArchivePath,
} from "./stream-database-backup.mjs";
import { assertSpacesInvariants } from "../../backend/api-service/spaces.js";

const require = createRequire(new URL("../../backend/api-service/package.json", import.meta.url));
const Database = require("better-sqlite3");
const TAR_BLOCK_SIZE = 512;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseOctal(buffer, fieldName) {
  const value = buffer.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(value)) throw new Error(`Invalid tar ${fieldName}`);
  return Number.parseInt(value, 8);
}

function parseHeader(header) {
  const storedChecksum = parseOctal(header.subarray(148, 156), "checksum");
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
  if (storedChecksum !== actualChecksum) throw new Error("Tar header checksum mismatch");
  const name = header.subarray(0, 100).toString("ascii").replace(/\0.*$/, "");
  validateArchivePath(name);
  const type = header[156];
  if (type !== 0 && type !== 0x30) throw new Error(`Unsupported tar entry type for ${name}`);
  return { name, size: parseOctal(header.subarray(124, 136), "size") };
}

function resolveStagedPath(stagingRoot, archivePath) {
  validateArchivePath(archivePath);
  const root = path.resolve(stagingRoot);
  const target = path.resolve(root, ...archivePath.split("/"));
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Archive entry escaped staging root: ${archivePath}`);
  }
  return target;
}

function allowedArchivePath(name) {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  return name === BACKUP_MANIFEST_PATH ||
    new RegExp(`^data/(?:_spaces|_users|${uuid})\\.db$`).test(name) ||
    new RegExp(`^data/spaces/${uuid}\\.db$`).test(name) ||
    new RegExp(`^uploads/spaces/${uuid}/.+$`).test(name);
}

/** Verify the companion sha256 file before any extraction occurs. */
export async function verifyArchiveChecksum(archivePath, checksumPath = `${archivePath}.sha256`) {
  const checksumLine = fs.readFileSync(checksumPath, "utf8").trim();
  const match = checksumLine.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
  if (!match || path.basename(match[2]) !== path.basename(archivePath)) {
    throw new Error("Checksum file does not name the selected archive");
  }
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(archivePath)) hash.update(chunk);
  if (hash.digest("hex") !== match[1].toLowerCase()) {
    throw new Error("Archive SHA-256 checksum mismatch");
  }
}

/** Extract only this tool's regular-file tar dialect into a new staging root. */
export async function extractBackupArchive(archivePath, stagingRoot) {
  const extracted = new Map();
  let pending = Buffer.alloc(0);
  let current = null;
  let padding = 0;
  let zeroBlocks = 0;

  try {
    const input = fs.createReadStream(archivePath).pipe(createGunzip());
    for await (const chunk of input) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length > 0) {
        if (current) {
          const length = Math.min(current.remaining, pending.length);
          const data = pending.subarray(0, length);
          fs.writeSync(current.fd, data);
          current.hash.update(data);
          current.remaining -= length;
          pending = pending.subarray(length);
          if (current.remaining === 0) {
            fs.closeSync(current.fd);
            extracted.set(current.name, {
              sizeBytes: current.size,
              sha256: current.hash.digest("hex"),
            });
            padding = (TAR_BLOCK_SIZE - (current.size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
            current = null;
          }
          continue;
        }
        if (padding > 0) {
          const length = Math.min(padding, pending.length);
          pending = pending.subarray(length);
          padding -= length;
          continue;
        }
        if (pending.length < TAR_BLOCK_SIZE) break;
        const header = pending.subarray(0, TAR_BLOCK_SIZE);
        pending = pending.subarray(TAR_BLOCK_SIZE);
        if (header.every((byte) => byte === 0)) {
          zeroBlocks += 1;
          continue;
        }
        if (zeroBlocks > 0) throw new Error("Unexpected tar entry after end marker");
        const entry = parseHeader(header);
        if (!allowedArchivePath(entry.name)) throw new Error(`Unexpected archive entry: ${entry.name}`);
        if (extracted.has(entry.name)) throw new Error(`Duplicate archive entry: ${entry.name}`);
        const target = resolveStagedPath(stagingRoot, entry.name);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const fd = fs.openSync(target, "wx", 0o600);
        current = {
          ...entry,
          fd,
          remaining: entry.size,
          hash: crypto.createHash("sha256"),
        };
        if (entry.size === 0) {
          fs.closeSync(fd);
          extracted.set(entry.name, { sizeBytes: 0, sha256: current.hash.digest("hex") });
          current = null;
        }
      }
    }
  } finally {
    if (current?.fd !== undefined) fs.closeSync(current.fd);
  }
  if (current || padding > 0 || pending.length > 0 || zeroBlocks < 2) {
    throw new Error("Archive ended before a complete tar end marker");
  }
  return extracted;
}

function verifySqliteIntegrity(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma("integrity_check");
    if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
      throw new Error(`SQLite integrity_check failed for ${path.basename(databasePath)}`);
    }
  } finally {
    db.close();
  }
}

function verifySpaceImageAssets(stagingRoot, spaceId) {
  const databasePath = resolveStagedPath(stagingRoot, `data/spaces/${spaceId}.db`);
  const uploadsRoot = resolveStagedPath(stagingRoot, `uploads/spaces/${spaceId}`);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const hasImages = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'images'",
    ).get();
    if (!hasImages) return;
    const images = db.prepare(
      "SELECT path, size_bytes AS sizeBytes, sha256 FROM images",
    ).all();
    for (const image of images) {
      if (
        typeof image.path !== "string" ||
        !image.path ||
        image.path !== path.basename(image.path) ||
        image.path.includes("\\")
      ) {
        throw new Error(`Space ${spaceId} contains a noncanonical image path`);
      }
      const imagePath = path.resolve(uploadsRoot, image.path);
      if (!imagePath.startsWith(`${uploadsRoot}${path.sep}`)) {
        throw new Error(`Space ${spaceId} image path escaped its upload root`);
      }
      const stat = fs.statSync(imagePath, { throwIfNoEntry: false });
      if (!stat?.isFile()) throw new Error(`Space ${spaceId} is missing referenced image bytes`);
      if (Number.isSafeInteger(image.sizeBytes) && image.sizeBytes >= 0 && stat.size !== image.sizeBytes) {
        throw new Error(`Space ${spaceId} image size does not match its database row`);
      }
      if (SHA256_PATTERN.test(image.sha256 || "")) {
        const digest = crypto.createHash("sha256").update(fs.readFileSync(imagePath)).digest("hex");
        if (digest !== image.sha256) throw new Error(`Space ${spaceId} image hash does not match its database row`);
      }
    }
  } finally {
    db.close();
  }
}

function requireManifestShape(manifest) {
  if (manifest?.format !== BACKUP_FORMAT || manifest?.version !== BACKUP_FORMAT_VERSION) {
    throw new Error("Unsupported production backup format");
  }
  if (manifest.scope !== "full") throw new Error("Selected diagnostic backups cannot be restored as a full estate");
  if (!Number.isFinite(Date.parse(manifest.createdAt))) throw new Error("Backup manifest timestamp is invalid");
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.spaces)) {
    throw new Error("Backup manifest is incomplete");
  }
}

/** Validate hashes, every SQLite file, metadata invariants, and the complete space set. */
export function verifyStagedRestore(stagingRoot, extracted) {
  const manifestPath = resolveStagedPath(stagingRoot, BACKUP_MANIFEST_PATH);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  requireManifestShape(manifest);
  const expectedPaths = new Set();
  for (const entry of manifest.entries) {
    validateArchivePath(entry?.path);
    if (!allowedArchivePath(entry.path)) throw new Error(`Unexpected manifest path: ${entry.path}`);
    if (expectedPaths.has(entry.path)) throw new Error(`Duplicate manifest path: ${entry.path}`);
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !SHA256_PATTERN.test(entry.sha256)) {
      throw new Error(`Invalid manifest metadata for ${entry.path}`);
    }
    const actual = extracted.get(entry.path);
    if (!actual || actual.sizeBytes !== entry.sizeBytes || actual.sha256 !== entry.sha256) {
      throw new Error(`Manifest verification failed for ${entry.path}`);
    }
    expectedPaths.add(entry.path);
  }
  const nonManifestPaths = [...extracted.keys()].filter((name) => name !== BACKUP_MANIFEST_PATH);
  if (nonManifestPaths.some((name) => !expectedPaths.has(name)) || expectedPaths.size !== nonManifestPaths.length) {
    throw new Error("Archive entries do not exactly match the manifest");
  }
  for (const required of ["data/_spaces.db", "data/_users.db"]) {
    if (!expectedPaths.has(required)) throw new Error(`Full backup is missing ${required}`);
  }
  for (const archivePath of expectedPaths) {
    if (archivePath.endsWith(".db")) verifySqliteIntegrity(resolveStagedPath(stagingRoot, archivePath));
  }

  const authDb = new Database(resolveStagedPath(stagingRoot, "data/_users.db"), { readonly: true, fileMustExist: true });
  const spacesDb = new Database(resolveStagedPath(stagingRoot, "data/_spaces.db"), { readonly: true, fileMustExist: true });
  try {
    assertSpacesInvariants(spacesDb, { authDb });
    const metadataSpaceIds = spacesDb.prepare("SELECT id FROM spaces ORDER BY id").pluck().all();
    const manifestSpaceIds = manifest.spaces.map((space) => space?.spaceId).sort();
    if (new Set(manifestSpaceIds).size !== manifestSpaceIds.length || manifestSpaceIds.some((id) => !UUID_PATTERN.test(id))) {
      throw new Error("Backup manifest contains invalid or duplicate space ids");
    }
    if (JSON.stringify(metadataSpaceIds) !== JSON.stringify(manifestSpaceIds)) {
      throw new Error("Space metadata and archived space databases do not match");
    }
    for (const space of manifest.spaces) {
      const expectedDatabasePath = `data/spaces/${space.spaceId}.db`;
      const expectedUploadsPrefix = `uploads/spaces/${space.spaceId}/`;
      if (space.databasePath !== expectedDatabasePath || space.uploadsPrefix !== expectedUploadsPrefix) {
        throw new Error(`Invalid restore mapping for space ${space.spaceId}`);
      }
      if (!expectedPaths.has(expectedDatabasePath)) throw new Error(`Missing database for space ${space.spaceId}`);
      verifySpaceImageAssets(stagingRoot, space.spaceId);
    }
    for (const archivePath of expectedPaths) {
      if (!archivePath.startsWith("uploads/spaces/")) continue;
      const spaceId = archivePath.split("/")[2];
      if (!manifestSpaceIds.includes(spaceId)) throw new Error(`Upload belongs to an unknown space: ${spaceId}`);
    }
  } finally {
    spacesDb.close();
    authDb.close();
  }
  return manifest;
}

function materializeSpaceUploadRoots(stagingRoot, manifest) {
  for (const space of manifest.spaces) {
    fs.mkdirSync(resolveStagedPath(stagingRoot, space.uploadsPrefix.slice(0, -1)), {
      recursive: true,
      mode: 0o700,
    });
  }
}

async function describeStagedFiles(stagingRoot) {
  const extracted = new Map();
  async function visit(directory, relativeDirectory = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Staged restore contains a symbolic link: ${relativePath}`);
      if (entry.isDirectory()) await visit(target, relativePath);
      else if (entry.isFile()) {
        validateArchivePath(relativePath);
        const hash = crypto.createHash("sha256");
        let sizeBytes = 0;
        for await (const chunk of fs.createReadStream(target)) {
          hash.update(chunk);
          sizeBytes += chunk.length;
        }
        extracted.set(relativePath, { sizeBytes, sha256: hash.digest("hex") });
      } else {
        throw new Error(`Staged restore contains an unsupported entry: ${relativePath}`);
      }
    }
  }
  await visit(stagingRoot);
  return extracted;
}

/** Recheck an already installed/staged pair without mutating it. */
export async function verifyStagedDirectory(stagingRoot) {
  const extracted = await describeStagedFiles(stagingRoot);
  const manifest = verifyStagedRestore(stagingRoot, extracted);
  for (const space of manifest.spaces) {
    const uploadRoot = resolveStagedPath(stagingRoot, space.uploadsPrefix.slice(0, -1));
    if (!fs.statSync(uploadRoot, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Missing upload root for space ${space.spaceId}`);
    }
  }
  return { createdAt: manifest.createdAt, spaces: manifest.spaces.length, entries: manifest.entries.length };
}

/** Verify and atomically publish a fully validated staging directory. */
export async function stageProductionRestore({ archivePath, checksumPath = `${archivePath}.sha256`, stagingDir }) {
  if (!archivePath || !stagingDir) throw new Error("archivePath and stagingDir are required");
  if (fs.existsSync(stagingDir)) throw new Error(`Staging target already exists: ${stagingDir}`);
  await verifyArchiveChecksum(archivePath, checksumPath);
  const parent = path.dirname(path.resolve(stagingDir));
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(parent, ".panino-restore-"));
  try {
    const extracted = await extractBackupArchive(archivePath, temporary);
    const manifest = verifyStagedRestore(temporary, extracted);
    materializeSpaceUploadRoots(temporary, manifest);
    fs.renameSync(temporary, stagingDir);
    return { stagingDir, createdAt: manifest.createdAt, spaces: manifest.spaces.length, entries: manifest.entries.length };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function usage() {
  return "Usage: stage-production-restore.mjs --archive PATH --staging-dir PATH [--checksum PATH]\n" +
    "   or: stage-production-restore.mjs --verify-dir PATH";
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (!["--archive", "--checksum", "--staging-dir", "--verify-dir"].includes(flag) || !argv[index + 1]) {
      throw new Error(`Unknown or incomplete option: ${flag}`);
    }
    options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[index + 1];
    index += 1;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
    } else if (options.verifyDir) {
      if (options.archive || options.checksum || options.stagingDir) {
        throw new Error("--verify-dir cannot be combined with archive staging options");
      }
      const result = await verifyStagedDirectory(options.verifyDir);
      process.stdout.write(
        `Restore directory is valid (${result.spaces} spaces, ${result.entries} files, snapshot ${result.createdAt}).\n`,
      );
    } else {
      const result = await stageProductionRestore(options);
      process.stdout.write(
        `Restore staged and validated at ${result.stagingDir} (${result.spaces} spaces, ${result.entries} files, snapshot ${result.createdAt}).\n` +
        "No live data was changed. Follow the deployment runbook for an approved maintenance-window swap.\n",
      );
    }
  } catch (error) {
    process.stderr.write(`[production-restore] ${error.message}\n${usage()}\n`);
    process.exitCode = 1;
  }
}
