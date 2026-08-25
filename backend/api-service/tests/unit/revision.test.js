// Unit tests for the backend-only revision actor attribution added in
// COLLAB-04 Phase 2 (§3.3/§4.3): actor_user_id/actor_kind are never
// client-writable and actor_kind is restricted to a fixed allowlist.
import { describe, it, expect, afterEach } from 'vitest';
import { getTestDb, closeAllConnections } from '../../db.js';
import { createRevisionSnapshot } from '../../revision.js';

function insertNote(db, { id, title = 't', content = 'c' }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO notes (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, title, content, now, now);
}

describe('createRevisionSnapshot actor attribution', () => {
  afterEach(() => {
    closeAllConnections();
  });

  it('defaults actor_user_id/actor_kind to null when not supplied', () => {
    const db = getTestDb(`revision-actor-default-${Date.now()}`, { inMemory: true });
    insertNote(db, { id: 'note-1' });

    const result = createRevisionSnapshot(db, {
      noteId: 'note-1',
      title: 't',
      content: 'c',
      type: 'auto',
    });

    expect(result.created).toBe(true);
    const row = db
      .prepare('SELECT actor_user_id, actor_kind FROM note_revisions WHERE id = ?')
      .get(result.revisionId);
    expect(row).toEqual({ actor_user_id: null, actor_kind: null });
  });

  it('records a supported actor kind together with the actor user id', () => {
    const db = getTestDb(`revision-actor-sync-${Date.now()}`, { inMemory: true });
    insertNote(db, { id: 'note-2' });

    const actorUserId = '11111111-1111-4111-8111-111111111111';
    const result = createRevisionSnapshot(db, {
      noteId: 'note-2',
      title: 't',
      content: 'c2',
      type: 'auto',
      actorUserId,
      actorKind: 'sync',
    });

    const row = db
      .prepare('SELECT actor_user_id, actor_kind FROM note_revisions WHERE id = ?')
      .get(result.revisionId);
    expect(row).toEqual({ actor_user_id: actorUserId, actor_kind: 'sync' });
  });

  it.each(['collab', 'system'])('accepts the %s actor kind', (actorKind) => {
    const db = getTestDb(`revision-actor-kind-${actorKind}-${Date.now()}`, { inMemory: true });
    insertNote(db, { id: 'note-3' });

    const result = createRevisionSnapshot(db, {
      noteId: 'note-3',
      title: 't',
      content: 'c3',
      type: 'manual',
      actorUserId: '22222222-2222-4222-8222-222222222222',
      actorKind,
    });

    const row = db
      .prepare('SELECT actor_kind FROM note_revisions WHERE id = ?')
      .get(result.revisionId);
    expect(row.actor_kind).toBe(actorKind);
  });

  it('silently drops an unsupported actor kind to null rather than trusting it', () => {
    const db = getTestDb(`revision-actor-invalid-${Date.now()}`, { inMemory: true });
    insertNote(db, { id: 'note-4' });

    const result = createRevisionSnapshot(db, {
      noteId: 'note-4',
      title: 't',
      content: 'c4',
      type: 'auto',
      actorUserId: '33333333-3333-4333-8333-333333333333',
      // A client (or a bug) could supply an arbitrary string here; only the
      // fixed allowlist may ever be persisted.
      actorKind: 'client-supplied-nonsense',
    });

    const row = db
      .prepare('SELECT actor_user_id, actor_kind FROM note_revisions WHERE id = ?')
      .get(result.revisionId);
    expect(row).toEqual({
      actor_user_id: '33333333-3333-4333-8333-333333333333',
      actor_kind: null,
    });
  });
});
