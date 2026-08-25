import express from 'express';
import { createHash } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import { v4 as uuidv4 } from 'uuid';
import { getAuthDb, getDb, getUserDb, listUserDbIds } from './db.js';
import { resolveSpaceAccess } from './spaces.js';
import { pokeSpaceSubscribers } from './websocket.js';

export const revisionRoutes = express.Router();

const AUTO_THROTTLE_MINUTES = 5;
const KEEP_ALL_HOURS = 48;
const HARD_CAP_PER_NOTE = 200;
const PRUNE_GATE_MINUTES = 60;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAINTENANCE_TIME_BUDGET_MS = 4000;
const MAINTENANCE_BATCH_SIZE = 50;

const maintenanceLocks = new Set();
const maintenanceCheckpoints = new Map();
let maintenanceTimer = null;

function hashContent(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function normalizeText(value) {
  if (value == null) return '';
  return String(value);
}

function validateRevisionType(type) {
  return type === 'auto' || type === 'manual' || type === 'pre-restore';
}

// Backend-only revision attribution (COLLAB-04 §3.3/§4.3). Only these three
// kinds are ever recorded; anything else (including client-supplied values)
// is silently dropped to null rather than trusted.
const ACTOR_KINDS = new Set(['sync', 'collab', 'system']);

function validateActorKind(actorKind) {
  return ACTOR_KINDS.has(actorKind) ? actorKind : null;
}

function createRevisionRowPayload({ noteId, title, content, type, createdAt, actorUserId = null, actorKind = null }) {
  const safeType = validateRevisionType(type) ? type : 'auto';
  const safeTitle = title == null ? null : String(title);
  const safeContent = normalizeText(content);
  const uncompressed = Buffer.from(safeContent, 'utf8');
  const compressed = gzipSync(uncompressed);
  return {
    id: uuidv4(),
    noteId,
    title: safeTitle,
    contentGzip: compressed,
    type: safeType,
    contentSha256: hashContent(safeContent),
    uncompressedBytes: uncompressed.length,
    compressedBytes: compressed.length,
    createdAt: createdAt || new Date().toISOString(),
    content: safeContent,
    actorUserId: actorUserId == null ? null : String(actorUserId),
    actorKind: validateActorKind(actorKind),
  };
}

function getLatestRevision(db, noteId) {
  return db.prepare(`
    SELECT id, title, content_sha256
    FROM note_revisions
    WHERE note_id = ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 1
  `).get(noteId);
}

function isAutoThrottled(db, noteId) {
  const row = db.prepare(`
    SELECT 1 as blocked
    FROM note_revisions
    WHERE note_id = ?
      AND type = 'auto'
      AND datetime(created_at) > datetime('now', '-${AUTO_THROTTLE_MINUTES} minutes')
    LIMIT 1
  `).get(noteId);
  return !!row;
}

function shouldRunPrune(db, noteId) {
  const row = db.prepare('SELECT last_pruned_at FROM note_revision_meta WHERE note_id = ?').get(noteId);
  if (!row || !row.last_pruned_at) return true;

  const gate = db.prepare(`
    SELECT datetime(?) <= datetime('now', '-${PRUNE_GATE_MINUTES} minutes') AS due
  `).get(row.last_pruned_at);

  return !!gate?.due;
}

function markPrunedNow(db, noteId) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO note_revision_meta (note_id, last_pruned_at)
    VALUES (?, ?)
    ON CONFLICT(note_id) DO UPDATE SET last_pruned_at = excluded.last_pruned_at
  `).run(noteId, now);
}

function pruneAgeDensity(db, noteId) {
  const rows = db.prepare(`
    SELECT id, created_at
    FROM note_revisions
    WHERE note_id = ?
      AND type IN ('auto', 'pre-restore')
      AND datetime(created_at) < datetime('now', '-${KEEP_ALL_HOURS} hours')
    ORDER BY datetime(created_at) DESC, id DESC
  `).all(noteId);

  const keepByDay = new Set();
  const idsToDelete = [];

  for (const row of rows) {
    const dayKey = String(row.created_at || '').slice(0, 10);
    if (!keepByDay.has(dayKey)) {
      keepByDay.add(dayKey);
      continue;
    }
    idsToDelete.push(row.id);
  }

  if (!idsToDelete.length) return 0;

  const deleteStmt = db.prepare('DELETE FROM note_revisions WHERE id = ?');
  for (const id of idsToDelete) {
    deleteStmt.run(id);
  }
  return idsToDelete.length;
}

function pruneHardCap(db, noteId) {
  const rows = db.prepare(`
    SELECT id
    FROM note_revisions
    WHERE note_id = ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT -1 OFFSET ${HARD_CAP_PER_NOTE}
  `).all(noteId);

  if (!rows.length) return 0;

  const deleteStmt = db.prepare('DELETE FROM note_revisions WHERE id = ?');
  for (const row of rows) {
    deleteStmt.run(row.id);
  }

  return rows.length;
}

export function pruneNoteRevisions(db, noteId) {
  const deletedByDensity = pruneAgeDensity(db, noteId);
  const deletedByCap = pruneHardCap(db, noteId);
  markPrunedNow(db, noteId);
  return deletedByDensity + deletedByCap;
}

export function deleteNoteRevisionsForDeletedNote(db, noteId) {
  db.prepare('DELETE FROM note_revisions WHERE note_id = ?').run(noteId);
  db.prepare('DELETE FROM note_revision_meta WHERE note_id = ?').run(noteId);
}

export function cleanupOrphanRevisionRows(db) {
  const deletedRevisions = db.prepare(`
    DELETE FROM note_revisions
    WHERE note_id NOT IN (SELECT id FROM notes)
  `).run().changes;

  const deletedMeta = db.prepare(`
    DELETE FROM note_revision_meta
    WHERE note_id NOT IN (SELECT id FROM notes)
  `).run().changes;

  return { deletedRevisions, deletedMeta };
}

export function createRevisionSnapshot(db, {
  noteId,
  title,
  content,
  type = 'auto',
  skipDuplicateCheck = false,
  enforceAutoThrottle = false,
  runPruneGate = true,
  actorUserId = null,
  actorKind = null,
}) {
  const payload = createRevisionRowPayload({ noteId, title, content, type, actorUserId, actorKind });

  if (!skipDuplicateCheck) {
    const latest = getLatestRevision(db, noteId);
    if (latest && latest.content_sha256 === payload.contentSha256 && (latest.title ?? null) === (payload.title ?? null)) {
      return { created: false, reason: 'duplicate-latest' };
    }
  }

  if (enforceAutoThrottle && payload.type === 'auto' && isAutoThrottled(db, noteId)) {
    return { created: false, reason: 'throttle' };
  }

  db.prepare(`
    INSERT INTO note_revisions (
      id, note_id, title, content_gzip, type, content_sha256,
      uncompressed_bytes, compressed_bytes, created_at,
      actor_user_id, actor_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.id,
    payload.noteId,
    payload.title,
    payload.contentGzip,
    payload.type,
    payload.contentSha256,
    payload.uncompressedBytes,
    payload.compressedBytes,
    payload.createdAt,
    payload.actorUserId,
    payload.actorKind
  );

  if (runPruneGate && shouldRunPrune(db, noteId)) {
    pruneNoteRevisions(db, noteId);
  }

  return { created: true, revisionId: payload.id };
}

function decodeRevisionContent(contentGzip) {
  const buffer = Buffer.isBuffer(contentGzip) ? contentGzip : Buffer.from(contentGzip);
  return gunzipSync(buffer).toString('utf8');
}

function ensureNoteExists(db, noteId) {
  const note = db.prepare('SELECT id, title, content, updated_at FROM notes WHERE id = ?').get(noteId);
  return note || null;
}

function resolveRevisionTarget(req) {
  const userId = req.user?.user_id;
  const requestedSpace = req.query?.space;

  if (requestedSpace === undefined) {
    return {
      db: getUserDb(userId),
      dbKey: `user:${userId}`,
      isSpace: false,
    };
  }

  const access = resolveSpaceAccess({
    spaceId: requestedSpace,
    actorUserId: userId,
  });
  if (!access) return null;

  const dbKey = `space:${access.spaceId}`;
  return {
    db: getDb(dbKey),
    dbKey,
    isSpace: true,
  };
}

function revisionTargetNotFound(res) {
  return res.status(404).json({ error: 'Not found', code: 'SPACE_NOT_FOUND' });
}

function revisionNoteNotFound(res, target) {
  return res.status(404).json({ error: target.isSpace ? 'Not found' : 'Note not found' });
}

function actorDisplay(actorUserId) {
  if (!actorUserId) return null;
  const profile = getAuthDb()
    .prepare('SELECT id, name FROM users WHERE id = ?')
    .get(actorUserId);
  return {
    id: actorUserId,
    name: profile?.name || 'Former member',
  };
}

function serializeRevision(row, { includeContent = false } = {}) {
  return {
    id: row.id,
    noteId: row.note_id,
    title: row.title,
    type: row.type,
    createdAt: row.created_at,
    ...(row.uncompressed_bytes === undefined ? {} : {
      uncompressedBytes: row.uncompressed_bytes,
      compressedBytes: row.compressed_bytes,
    }),
    ...(includeContent ? { content: row.content } : {}),
    actor: actorDisplay(row.actor_user_id),
    actorKind: row.actor_kind || null,
  };
}

function parseLimit(value, fallback = 50, max = 200) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function buildListQuery({ hasBefore, hasBeforeId }) {
  if (!hasBefore) {
    return `
      SELECT id, note_id, title, type, created_at, uncompressed_bytes, compressed_bytes,
             actor_user_id, actor_kind
      FROM note_revisions
      WHERE note_id = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `;
  }

  if (hasBefore && hasBeforeId) {
    return `
      SELECT id, note_id, title, type, created_at, uncompressed_bytes, compressed_bytes,
             actor_user_id, actor_kind
      FROM note_revisions
      WHERE note_id = ?
        AND (
          created_at < ? OR (created_at = ? AND id < ?)
        )
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `;
  }

  return `
    SELECT id, note_id, title, type, created_at, uncompressed_bytes, compressed_bytes,
           actor_user_id, actor_kind
    FROM note_revisions
    WHERE note_id = ?
      AND created_at < ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `;
}

function pokeUserClients(req, userId) {
  req.clients.forEach((clientInfo, clientWs) => {
    if (clientInfo.userId === userId && clientWs.readyState === 1) {
      clientWs.send(JSON.stringify({ type: 'sync' }));
    }
  });
}

revisionRoutes.get('/notes/:id/revisions', (req, res) => {
  const userId = req.user?.user_id;
  const noteId = req.params.id;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  let target;
  try {
    target = resolveRevisionTarget(req);
  } catch (error) {
    console.error('[revision] Failed to authorize revision list:', error?.code || error?.message || 'unknown error');
    return res.status(500).json({ error: 'Failed to load revisions' });
  }
  if (!target) return revisionTargetNotFound(res);

  const { db } = target;
  const note = ensureNoteExists(db, noteId);
  if (!note) return revisionNoteNotFound(res, target);

  const limit = parseLimit(req.query.limit, 50, 200);
  const before = req.query.before ? String(req.query.before) : null;
  const beforeId = req.query.beforeId ? String(req.query.beforeId) : null;

  const hasBefore = !!before;
  const hasBeforeId = !!beforeId;

  const query = buildListQuery({ hasBefore, hasBeforeId });

  const rows = hasBefore
    ? (hasBeforeId
      ? db.prepare(query).all(noteId, before, before, beforeId, limit)
      : db.prepare(query).all(noteId, before, limit))
    : db.prepare(query).all(noteId, limit);

  return res.json({
    revisions: rows.map((row) => serializeRevision(row)),
  });
});

revisionRoutes.get('/notes/:id/revisions/:revisionId', (req, res) => {
  const userId = req.user?.user_id;
  const noteId = req.params.id;
  const revisionId = req.params.revisionId;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  let target;
  try {
    target = resolveRevisionTarget(req);
  } catch (error) {
    console.error('[revision] Failed to authorize revision detail:', error?.code || error?.message || 'unknown error');
    return res.status(500).json({ error: 'Failed to load revision' });
  }
  if (!target) return revisionTargetNotFound(res);

  const { db } = target;
  const note = ensureNoteExists(db, noteId);
  if (!note) return revisionNoteNotFound(res, target);

  const row = db.prepare(`
    SELECT id, note_id, title, type, created_at, content_gzip,
           actor_user_id, actor_kind
    FROM note_revisions
    WHERE note_id = ? AND id = ?
    LIMIT 1
  `).get(noteId, revisionId);

  if (!row) return res.status(404).json({ error: 'Revision not found' });

  try {
    const content = decodeRevisionContent(row.content_gzip);
    return res.json({ revision: serializeRevision({ ...row, content }, { includeContent: true }) });
  } catch (error) {
    console.error('[revision] Failed to decompress revision payload:', error);
    return res.status(422).json({ error: 'Revision payload is corrupt' });
  }
});

revisionRoutes.post('/notes/:id/revisions', (req, res) => {
  const userId = req.user?.user_id;
  const noteId = req.params.id;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  let target;
  try {
    target = resolveRevisionTarget(req);
  } catch (error) {
    console.error('[revision] Failed to authorize manual revision:', error?.code || error?.message || 'unknown error');
    return res.status(500).json({ error: 'Failed to save revision' });
  }
  if (!target) return revisionTargetNotFound(res);

  const { db } = target;
  const note = ensureNoteExists(db, noteId);
  if (!note) return revisionNoteNotFound(res, target);

  const tx = db.transaction(() => createRevisionSnapshot(db, {
    noteId,
    title: note.title,
    content: note.content,
    type: 'manual',
    skipDuplicateCheck: false,
    enforceAutoThrottle: false,
    runPruneGate: true,
    actorUserId: userId,
    actorKind: 'system',
  }));

  const result = tx();

  if (!result.created && result.reason === 'duplicate-latest') {
    return res.status(200).json({ created: false, reason: 'duplicate-latest' });
  }

  return res.status(201).json({ created: true, revisionId: result.revisionId });
});

revisionRoutes.post('/notes/:id/revisions/:revisionId/restore', (req, res) => {
  const userId = req.user?.user_id;
  const noteId = req.params.id;
  const revisionId = req.params.revisionId;
  const expectedUpdatedAt = req.body?.expectedUpdatedAt ?? null;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  let target;
  try {
    target = resolveRevisionTarget(req);
  } catch (error) {
    console.error('[revision] Failed to authorize revision restore:', error?.code || error?.message || 'unknown error');
    return res.status(500).json({ error: 'Failed to restore revision' });
  }
  if (!target) return revisionTargetNotFound(res);

  const { db } = target;

  try {
    const tx = db.transaction(() => {
      const current = ensureNoteExists(db, noteId);
      if (!current) {
        const err = new Error('NOTE_NOT_FOUND');
        err.httpStatus = 404;
        throw err;
      }

      if (expectedUpdatedAt && current.updated_at !== expectedUpdatedAt) {
        const err = new Error('VERSION_CONFLICT');
        err.httpStatus = 409;
        throw err;
      }

      const revision = db.prepare(`
        SELECT id, note_id, title, content_gzip
        FROM note_revisions
        WHERE id = ? AND note_id = ?
      `).get(revisionId, noteId);

      if (!revision) {
        const err = new Error('REVISION_NOT_FOUND');
        err.httpStatus = 404;
        throw err;
      }

      let restoredContent;
      try {
        restoredContent = decodeRevisionContent(revision.content_gzip);
      } catch (error) {
        const err = new Error('CORRUPT_REVISION');
        err.httpStatus = 422;
        throw err;
      }

      const preRestore = createRevisionSnapshot(db, {
        noteId,
        title: current.title,
        content: current.content,
        type: 'pre-restore',
        skipDuplicateCheck: true,
        enforceAutoThrottle: false,
        runPruneGate: true,
        actorUserId: userId,
        actorKind: 'system',
      });

      const nextUpdatedAt = new Date().toISOString();
      db.prepare(`
        UPDATE notes
        SET title = ?, content = ?, updated_at = ?
        WHERE id = ?
      `).run(revision.title, restoredContent, nextUpdatedAt, noteId);

      return {
        restored: true,
        note: {
          id: noteId,
          title: revision.title,
          content: restoredContent,
          updatedAt: nextUpdatedAt,
        },
        preRestoreRevisionId: preRestore.revisionId,
      };
    });

    const result = tx();
    if (target.isSpace) {
      pokeSpaceSubscribers(req.clients, target.dbKey, null);
    } else {
      pokeUserClients(req, userId);
    }
    return res.json(result);
  } catch (error) {
    if (error.httpStatus === 404) {
      return res.status(404).json({ error: 'Not found' });
    }
    if (error.httpStatus === 409) {
      return res.status(409).json({ error: 'Conflict' });
    }
    if (error.httpStatus === 422) {
      return res.status(422).json({ error: 'Revision payload is corrupt' });
    }
    console.error('[revision] Restore failed:', error);
    return res.status(500).json({ error: 'Failed to restore revision' });
  }
});

function runMaintenancePassForDb(dbKey) {
  if (maintenanceLocks.has(dbKey)) return;
  maintenanceLocks.add(dbKey);

  try {
    const db = getDb(dbKey);
    const startedAt = Date.now();
    let lastNoteId = maintenanceCheckpoints.get(dbKey) || null;
    let hasMore = true;

    while (hasMore && Date.now() - startedAt < MAINTENANCE_TIME_BUDGET_MS) {
      const notes = db.prepare(`
        SELECT DISTINCT note_id
        FROM note_revisions
        WHERE (? IS NULL OR note_id > ?)
        ORDER BY note_id ASC
        LIMIT ?
      `).all(lastNoteId, lastNoteId, MAINTENANCE_BATCH_SIZE);

      if (!notes.length) {
        hasMore = false;
        break;
      }

      for (const row of notes) {
        pruneNoteRevisions(db, row.note_id);
        lastNoteId = row.note_id;
      }

      if (notes.length < MAINTENANCE_BATCH_SIZE) {
        hasMore = false;
      }
    }

    cleanupOrphanRevisionRows(db);

    if (hasMore) {
      maintenanceCheckpoints.set(dbKey, lastNoteId);
    } else {
      maintenanceCheckpoints.delete(dbKey);
    }
  } catch (error) {
    console.error(`[revision] Maintenance pass failed for ${dbKey}:`, error);
  } finally {
    maintenanceLocks.delete(dbKey);
  }
}

function runGlobalMaintenancePass() {
  for (const dbKey of listUserDbIds()) {
    runMaintenancePassForDb(dbKey);
  }
}

export function startRevisionMaintenanceJob() {
  if (maintenanceTimer) return;

  setTimeout(() => {
    runGlobalMaintenancePass();
  }, 10_000);

  maintenanceTimer = setInterval(() => {
    runGlobalMaintenancePass();
  }, MAINTENANCE_INTERVAL_MS);
}

export function stopRevisionMaintenanceJob() {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}

export default revisionRoutes;
