import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4, validate as validateUuid } from "uuid";
import { contentHash } from "@panino/content-merge";
import { getHealthyDb, getSpacesDb, parseDbKey } from "./db.js";
import { rewriteCanonicalImageDestinations } from "./markdownImageRewriter.js";
import {
  resolveDatabaseUploadRoot,
  resolveStoredImagePath,
} from "./spaceStorage.js";
import { resolveSpaceAccess } from "./spaces.js";
import { pokePersonalClients, pokeSpaceSubscribers } from "./websocket.js";

export const spaceTransferRoutes = express.Router();

const ACTIVE_STATUSES = new Set([
  "checkpointed",
  "copying_images",
  "copying_document",
  "destination_confirmed",
  "recoverable_duplicate",
]);

class TransferError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function now() {
  return new Date().toISOString();
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function publicTransfer(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceDbKey: row.source_db_key,
    destinationDbKey: row.destination_db_key,
    sourceNoteId: row.source_note_id,
    destinationNoteId: row.destination_note_id,
    destinationFolderId: row.destination_folder_id,
    status: row.status,
    warnings: safeJson(row.warnings_json, []),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    destinationConfirmedAt: row.destination_confirmed_at,
    sourceDeletedAt: row.source_deleted_at,
    revisionHistoryTransferred: false,
  };
}

function transferRow(actorUserId, transferId) {
  if (!validateUuid(transferId)) return null;
  return getSpacesDb().prepare(
    "SELECT * FROM space_transfers WHERE id = ? AND actor_user_id = ?",
  ).get(transferId, actorUserId);
}

function updateTransfer(id, fields) {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  getSpacesDb().prepare(
    `UPDATE space_transfers SET ${set}, updated_at = ? WHERE id = ?`,
  ).run(...entries.map(([, value]) => value), now(), id);
}

function authorizeDatabase(dbKey, actorUserId, operation) {
  let parsed;
  try {
    parsed = parseDbKey(dbKey);
  } catch {
    throw new TransferError("TRANSFER_TARGET_INVALID", "Transfer target is invalid");
  }
  if (parsed.kind === "user") {
    if (parsed.id !== actorUserId) {
      throw new TransferError("TRANSFER_NOT_FOUND", "Not found", 404);
    }
  } else {
    let access;
    try {
      access = resolveSpaceAccess({ spaceId: parsed.id, actorUserId });
    } catch (error) {
      console.error("[space-transfer] authorization failed", error?.code || error?.message);
      throw new TransferError("TRANSFER_UNAVAILABLE", "Transfer is temporarily unavailable", 503);
    }
    if (!access) throw new TransferError("TRANSFER_NOT_FOUND", "Not found", 404);
  }
  return { ...parsed, db: getHealthyDb(parsed.dbKey, operation) };
}

function readSource(row, actorUserId) {
  const source = authorizeDatabase(row.source_db_key, actorUserId, "space-transfer-source");
  const note = source.db.prepare(
    "SELECT id, user_id, folder_id, title, content, created_at, updated_at FROM notes WHERE id = ?",
  ).get(row.source_note_id);
  if (!note) throw new TransferError("TRANSFER_SOURCE_MISSING", "Source Document is no longer available", 409);
  return { ...source, note };
}

function readDestination(row, actorUserId) {
  const destination = authorizeDatabase(
    row.destination_db_key,
    actorUserId,
    "space-transfer-destination",
  );
  if (row.destination_folder_id) {
    const folder = destination.db.prepare("SELECT id FROM folders WHERE id = ?").get(row.destination_folder_id);
    if (!folder) throw new TransferError("TRANSFER_FOLDER_MISSING", "Destination folder is no longer available", 409);
  }
  return destination;
}

function loadImage(db, imageId) {
  return db.prepare(
    "SELECT id, user_id, filename, mime_type, path, size_bytes, sha256, created_at FROM images WHERE id = ?",
  ).get(imageId);
}

function verifiedImage(dbKey, db, imageId, expectedSha256, expectedSize) {
  const row = loadImage(db, imageId);
  if (!row || row.sha256 !== expectedSha256 || Number(row.size_bytes) !== Number(expectedSize)) return false;
  const filePath = resolveStoredImagePath(dbKey, row.path);
  return Boolean(filePath && fs.existsSync(filePath)
    && fs.statSync(filePath).size === Number(expectedSize)
    && sha256File(filePath) === expectedSha256);
}

function planImages(row, source, destination) {
  const initial = rewriteCanonicalImageDestinations(source.note.content, {
    sourceDbKey: source.dbKey,
    destinationDbKey: destination.dbKey,
  });
  const imageMap = safeJson(row.image_map_json, {});
  const warnings = safeJson(row.warnings_json, []);
  const warned = new Set(warnings.map((warning) => `${warning.code}:${warning.imageId}`));
  for (const imageId of initial.noncanonicalImageIds) {
    const warningKey = `NONCANONICAL_SOURCE_IMAGE:${imageId}`;
    if (warned.has(warningKey)) continue;
    warnings.push({
      code: "NONCANONICAL_SOURCE_IMAGE",
      imageId,
      message: "A noncanonical same-origin image destination was preserved and was not rebound.",
    });
    warned.add(warningKey);
  }
  for (const imageId of initial.sourceImageIds) {
    const image = loadImage(source.db, imageId);
    const sourcePath = image && resolveStoredImagePath(source.dbKey, image.path);
    const valid = Boolean(
      image
      && sourcePath
      && fs.existsSync(sourcePath)
      && Number(image.size_bytes) === fs.statSync(sourcePath).size
      && image.sha256
      && image.sha256 === sha256File(sourcePath),
    );
    if (!valid) {
      delete imageMap[imageId];
      const warningKey = `SOURCE_IMAGE_MISSING:${imageId}`;
      if (!warned.has(warningKey)) {
        warnings.push({
          code: "SOURCE_IMAGE_MISSING",
          imageId,
          message: "A canonical source image was unavailable and its original destination was preserved.",
        });
        warned.add(warningKey);
      }
      continue;
    }
    if (!imageMap[imageId]) imageMap[imageId] = uuidv4();
  }
  updateTransfer(row.id, {
    status: "copying_images",
    image_map_json: JSON.stringify(imageMap),
    warnings_json: JSON.stringify(warnings),
    last_error: null,
  });
  return { imageMap, warnings };
}

function copyImages(row, source, destination, imageMap) {
  const destinationRoot = resolveDatabaseUploadRoot(destination.dbKey);
  fs.mkdirSync(destinationRoot, { recursive: true });
  for (const [sourceId, destinationId] of Object.entries(imageMap)) {
    const image = loadImage(source.db, sourceId);
    const sourcePath = image && resolveStoredImagePath(source.dbKey, image.path);
    if (!image || !sourcePath || !fs.existsSync(sourcePath)) {
      throw new TransferError("TRANSFER_SOURCE_IMAGE_CHANGED", "A source image changed during transfer", 409);
    }
    const existing = loadImage(destination.db, destinationId);
    if (existing) {
      if (verifiedImage(destination.dbKey, destination.db, destinationId, image.sha256, image.size_bytes)) continue;
      throw new TransferError("TRANSFER_DESTINATION_CONFLICT", "Destination image conflicts with this transfer", 409);
    }

    const extension = /^\.[a-z0-9]{1,8}$/i.test(path.extname(image.path))
      ? path.extname(image.path).toLowerCase()
      : ".bin";
    const relativePath = `${destinationId}${extension}`;
    const destinationPath = resolveStoredImagePath(destination.dbKey, relativePath);
    if (!destinationPath) throw new Error("Destination image path escaped its root");
    const temporaryPath = path.join(destinationRoot, `.${destinationId}.${row.id}.tmp`);
    fs.copyFileSync(sourcePath, temporaryPath);
    if (fs.statSync(temporaryPath).size !== Number(image.size_bytes) || sha256File(temporaryPath) !== image.sha256) {
      fs.unlinkSync(temporaryPath);
      throw new Error("Destination image verification failed");
    }
    fs.renameSync(temporaryPath, destinationPath);
    destination.db.prepare(
      `INSERT INTO images (id, user_id, filename, mime_type, path, size_bytes, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      destinationId,
      row.actor_user_id,
      image.filename,
      image.mime_type,
      relativePath,
      image.size_bytes,
      image.sha256,
      now(),
    );
    if (!verifiedImage(destination.dbKey, destination.db, destinationId, image.sha256, image.size_bytes)) {
      throw new Error("Destination image verification failed");
    }
  }
}

function copyDocument(row, source, destination, imageMap) {
  updateTransfer(row.id, { status: "copying_document" });
  const rewritten = rewriteCanonicalImageDestinations(source.note.content, {
    sourceDbKey: source.dbKey,
    destinationDbKey: destination.dbKey,
    imageMap,
  });
  const existing = destination.db.prepare(
    "SELECT id, folder_id, title, content FROM notes WHERE id = ?",
  ).get(row.destination_note_id);
  if (existing) {
    if (
      existing.folder_id !== row.destination_folder_id
      || existing.title !== source.note.title
      || existing.content !== rewritten.content
    ) {
      throw new TransferError("TRANSFER_DESTINATION_CONFLICT", "Destination Document conflicts with this transfer", 409);
    }
  } else {
    destination.db.prepare(
      `INSERT INTO notes (id, user_id, folder_id, title, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.destination_note_id,
      row.actor_user_id,
      row.destination_folder_id,
      source.note.title,
      rewritten.content,
      source.note.created_at || now(),
      now(),
    );
  }
}

function verifyDestination(row, destination, imageMap) {
  const note = destination.db.prepare("SELECT id FROM notes WHERE id = ?").get(row.destination_note_id);
  if (!note) return false;
  for (const [sourceId, destinationId] of Object.entries(imageMap)) {
    const sourceDb = getHealthyDb(row.source_db_key, "space-transfer-verify-source");
    const sourceImage = loadImage(sourceDb, sourceId);
    if (!sourceImage || !verifiedImage(
      destination.dbKey,
      destination.db,
      destinationId,
      sourceImage.sha256,
      sourceImage.size_bytes,
    )) return false;
  }
  return true;
}

async function sourceUnchanged(row, source) {
  return source.note.updated_at === row.source_updated_at
    && await contentHash(source.note.content) === row.source_content_sha256;
}

function poke(req, dbKey) {
  const parsed = parseDbKey(dbKey);
  if (parsed.kind === "space") pokeSpaceSubscribers(req.clients, parsed.dbKey, null);
  else pokePersonalClients(req.clients, parsed.id, null);
}

async function deleteVerifiedSource(req, row) {
  const source = authorizeDatabase(row.source_db_key, row.actor_user_id, "space-transfer-delete-source");
  source.note = source.db.prepare(
    "SELECT id, user_id, folder_id, title, content, created_at, updated_at FROM notes WHERE id = ?",
  ).get(row.source_note_id);
  const destination = readDestination(row, row.actor_user_id);
  const imageMap = safeJson(row.image_map_json, {});
  if (!verifyDestination(row, destination, imageMap)) {
    throw new TransferError("TRANSFER_DESTINATION_UNVERIFIED", "Destination verification must succeed before deleting the source", 409);
  }
  // Crash recovery: deletion may have committed in the source database before
  // the metadata checkpoint was written. A still-verified destination makes
  // that state safely idempotent.
  if (!source.note) {
    const timestamp = row.source_deleted_at || now();
    updateTransfer(row.id, { status: "complete", source_deleted_at: timestamp, last_error: null });
    return transferRow(row.actor_user_id, row.id);
  }
  if (!await sourceUnchanged(row, source)) {
    throw new TransferError("TRANSFER_SOURCE_CHANGED", "Source Document changed; keep both or retry from a new transfer", 409);
  }
  source.db.prepare("DELETE FROM notes WHERE id = ?").run(row.source_note_id);
  const timestamp = now();
  updateTransfer(row.id, { status: "complete", source_deleted_at: timestamp, last_error: null });
  poke(req, source.dbKey);
  return transferRow(row.actor_user_id, row.id);
}

export async function resumeSpaceTransfer(req, initialRow, { deleteSource = true } = {}) {
  let row = transferRow(initialRow.actor_user_id, initialRow.id);
  if (!row) throw new TransferError("TRANSFER_NOT_FOUND", "Not found", 404);
  if (!ACTIVE_STATUSES.has(row.status)) return row;
  try {
    const source = readSource(row, row.actor_user_id);
    const destination = readDestination(row, row.actor_user_id);
    if (!await sourceUnchanged(row, source)) {
      throw new TransferError("TRANSFER_SOURCE_CHANGED", "Source Document changed; keep both or start a new transfer", 409);
    }
    const plan = planImages(row, source, destination);
    row = transferRow(row.actor_user_id, row.id);
    copyImages(row, source, destination, plan.imageMap);
    copyDocument(row, source, destination, plan.imageMap);
    if (!verifyDestination(row, destination, plan.imageMap)) throw new Error("Destination verification failed");
    updateTransfer(row.id, {
      status: "destination_confirmed",
      destination_confirmed_at: now(),
      last_error: null,
    });
    poke(req, destination.dbKey);
    row = transferRow(row.actor_user_id, row.id);
    if (!deleteSource) return row;
    return await deleteVerifiedSource(req, row);
  } catch (error) {
    row = transferRow(initialRow.actor_user_id, initialRow.id);
    let destinationExists = false;
    try {
      const destination = row && authorizeDatabase(
        row.destination_db_key,
        row.actor_user_id,
        "space-transfer-failure-check",
      );
      destinationExists = Boolean(destination?.db.prepare("SELECT 1 FROM notes WHERE id = ?")
        .get(row.destination_note_id));
    } catch {
      // The actor may have lost access during the operation. Preserve the
      // last durable status without probing or reopening the target.
    }
    updateTransfer(initialRow.id, {
      status: destinationExists ? "recoverable_duplicate" : row?.status || "checkpointed",
      last_error: error instanceof TransferError ? error.message : "Transfer interrupted; retry is safe.",
    });
    throw error;
  }
}

function sendError(res, error) {
  const status = error instanceof TransferError ? error.status : 500;
  if (status >= 500) console.error("[space-transfer] operation failed", error?.code || error?.message);
  const code = error instanceof TransferError ? error.code : "TRANSFER_FAILED";
  const message = error instanceof TransferError ? error.message : "Transfer interrupted; retry is safe.";
  return res.status(status).json({ error: message, code });
}

spaceTransferRoutes.get("/space-transfers", (req, res) => {
  try {
    const rows = getSpacesDb().prepare(
      `SELECT * FROM space_transfers
        WHERE actor_user_id = ? AND status NOT IN ('complete', 'kept_both')
      ORDER BY updated_at DESC LIMIT 100`,
    ).all(req.user.user_id);
    const visible = [];
    for (const row of rows) {
      try {
        authorizeDatabase(row.source_db_key, req.user.user_id, "space-transfer-list-source");
        authorizeDatabase(row.destination_db_key, req.user.user_id, "space-transfer-list-destination");
        visible.push(publicTransfer(row));
      } catch (error) {
        if (error instanceof TransferError && error.status === 404) continue;
        throw error;
      }
    }
    return res.json({ transfers: visible });
  } catch (error) {
    return sendError(res, error);
  }
});

spaceTransferRoutes.get("/space-transfers/:transferId", (req, res) => {
  try {
    const row = transferRow(req.user.user_id, req.params.transferId);
    if (!row) throw new TransferError("TRANSFER_NOT_FOUND", "Not found", 404);
    // Reauthorization is mandatory even for status polling.
    authorizeDatabase(row.source_db_key, req.user.user_id, "space-transfer-read-source");
    authorizeDatabase(row.destination_db_key, req.user.user_id, "space-transfer-read-destination");
    return res.json({ transfer: publicTransfer(row) });
  } catch (error) {
    return sendError(res, error);
  }
});

spaceTransferRoutes.post("/space-transfers", async (req, res) => {
  try {
    const actorUserId = req.user.user_id;
    const source = authorizeDatabase(req.body?.sourceDbKey, actorUserId, "space-transfer-create-source");
    const destination = authorizeDatabase(
      req.body?.destinationDbKey,
      actorUserId,
      "space-transfer-create-destination",
    );
    if (source.dbKey === destination.dbKey) {
      throw new TransferError("TRANSFER_SAME_DATABASE", "Use the normal move action within one database");
    }
    if (!validateUuid(req.body?.sourceNoteId)) {
      throw new TransferError("TRANSFER_SOURCE_INVALID", "Source Document is invalid");
    }
    const sourceNote = source.db.prepare(
      "SELECT id, content, updated_at FROM notes WHERE id = ?",
    ).get(req.body.sourceNoteId);
    if (!sourceNote) throw new TransferError("TRANSFER_NOT_FOUND", "Not found", 404);
    const destinationFolderId = req.body?.destinationFolderId || null;
    if (destinationFolderId && !validateUuid(destinationFolderId)) {
      throw new TransferError("TRANSFER_FOLDER_INVALID", "Destination folder is invalid");
    }
    if (destinationFolderId && !destination.db.prepare("SELECT 1 FROM folders WHERE id = ?").get(destinationFolderId)) {
      throw new TransferError("TRANSFER_FOLDER_MISSING", "Destination folder is no longer available", 409);
    }
    const timestamp = now();
    const transferId = uuidv4();
    getSpacesDb().prepare(
      `INSERT INTO space_transfers (
         id, actor_user_id, source_db_key, destination_db_key,
         source_note_id, destination_note_id, destination_folder_id,
         source_updated_at, source_content_sha256, status,
         image_map_json, warnings_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'checkpointed', '{}', '[]', ?, ?)`,
    ).run(
      transferId,
      actorUserId,
      source.dbKey,
      destination.dbKey,
      sourceNote.id,
      uuidv4(),
      destinationFolderId,
      sourceNote.updated_at,
      await contentHash(sourceNote.content),
      timestamp,
      timestamp,
    );
    const result = await resumeSpaceTransfer(req, transferRow(actorUserId, transferId));
    return res.status(201).json({ transfer: publicTransfer(result) });
  } catch (error) {
    return sendError(res, error);
  }
});

spaceTransferRoutes.post("/space-transfers/:transferId/retry", async (req, res) => {
  try {
    const row = transferRow(req.user.user_id, req.params.transferId);
    if (!row) throw new TransferError("TRANSFER_NOT_FOUND", "Not found", 404);
    const result = await resumeSpaceTransfer(req, row);
    return res.json({ transfer: publicTransfer(result) });
  } catch (error) {
    return sendError(res, error);
  }
});

spaceTransferRoutes.post("/space-transfers/:transferId/keep-both", (req, res) => {
  try {
    const row = transferRow(req.user.user_id, req.params.transferId);
    if (!row) throw new TransferError("TRANSFER_NOT_FOUND", "Not found", 404);
    if (!["destination_confirmed", "recoverable_duplicate"].includes(row.status)) {
      throw new TransferError("TRANSFER_RECOVERY_INVALID", "This transfer cannot keep both Documents", 409);
    }
    authorizeDatabase(row.source_db_key, req.user.user_id, "space-transfer-keep-source");
    const destination = authorizeDatabase(row.destination_db_key, req.user.user_id, "space-transfer-keep-destination");
    if (!verifyDestination(row, destination, safeJson(row.image_map_json, {}))) {
      throw new TransferError("TRANSFER_DESTINATION_UNVERIFIED", "Destination verification has not completed", 409);
    }
    updateTransfer(row.id, { status: "kept_both", last_error: null });
    return res.json({ transfer: publicTransfer(transferRow(req.user.user_id, row.id)) });
  } catch (error) {
    return sendError(res, error);
  }
});

spaceTransferRoutes.post("/space-transfers/:transferId/delete-source", async (req, res) => {
  try {
    const row = transferRow(req.user.user_id, req.params.transferId);
    if (!row) throw new TransferError("TRANSFER_NOT_FOUND", "Not found", 404);
    if (!["destination_confirmed", "recoverable_duplicate"].includes(row.status)) {
      throw new TransferError("TRANSFER_RECOVERY_INVALID", "This transfer cannot delete its source", 409);
    }
    const result = await deleteVerifiedSource(req, row);
    return res.json({ transfer: publicTransfer(result) });
  } catch (error) {
    return sendError(res, error);
  }
});
