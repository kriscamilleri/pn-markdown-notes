import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate as validateUuid } from "uuid";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const uploadsRoot = path.resolve(moduleDir, "uploads");
const spaceUploadsRoot = path.resolve(uploadsRoot, "spaces");

function parseDatabaseKey(dbKey) {
  if (typeof dbKey !== "string") throw new Error("Database key is required");
  const match = /^(user|space):(.+)$/.exec(dbKey);
  if (!match || !validateUuid(match[2])) {
    throw new Error("Database key must be a canonical user:<uuid> or space:<uuid> key");
  }
  const kind = match[1];
  const id = match[2].toLowerCase();
  if (`${kind}:${id}` !== dbKey) {
    throw new Error("Database key must use its canonical lowercase form");
  }
  return { kind, id };
}

export function resolveSpaceUploadRoot(spaceId) {
  if (typeof spaceId !== "string" || !validateUuid(spaceId)) {
    throw new Error("Space id must be a UUID");
  }
  const resolved = path.resolve(spaceUploadsRoot, spaceId);
  if (!resolved.startsWith(`${spaceUploadsRoot}${path.sep}`)) {
    throw new Error("Space upload path escaped its root");
  }
  return resolved;
}

/** Resolve the upload root while preserving the legacy flat personal layout. */
export function resolveDatabaseUploadRoot(dbKey) {
  const { kind, id } = parseDatabaseKey(dbKey);
  return kind === "user" ? uploadsRoot : resolveSpaceUploadRoot(id);
}

/** Resolve a stored relative image path without allowing it to escape its database root. */
export function resolveStoredImagePath(dbKey, relativePath) {
  const { kind } = parseDatabaseKey(dbKey);
  const root = resolveDatabaseUploadRoot(dbKey);
  const absolutePath = path.resolve(root, relativePath || "");
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  // Shared uploads are nested beneath the legacy personal root. Reserve that
  // subtree so a crafted personal image row cannot bypass space membership.
  if (
    kind === "user" &&
    (absolutePath === spaceUploadsRoot || absolutePath.startsWith(`${spaceUploadsRoot}${path.sep}`))
  ) {
    return null;
  }
  return absolutePath;
}

/** Build the canonical Markdown/API destination for an image in one database. */
export function toCanonicalImageUrl(imageId, dbKey) {
  const { kind, id } = parseDatabaseKey(dbKey);
  const base = `/images/${imageId}`;
  return kind === "space" ? `${base}?space=${id}` : base;
}

export function deleteSpaceUploads(spaceId) {
  const target = resolveSpaceUploadRoot(spaceId);
  if (!fs.existsSync(target)) return { removed: false };
  fs.rmSync(target, { recursive: true, force: false });
  return { removed: true };
}
