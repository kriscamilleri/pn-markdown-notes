import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  cleanupTestUser,
  createTestApp,
  getTestToken,
  setupTestUser,
} from '../testHelpers.js';
import { deleteTestDb, getAuthDb, getDb, getSpacesDb } from '../../db.js';
import {
  addEditorMember,
  createSpace,
  removeEditorMember,
} from '../../spaces.js';
import { createRevisionSnapshot } from '../../revision.js';

const FLAG = 'SHARED_SPACES_ENABLED';
const ORIGINAL_FLAG = process.env[FLAG];

describe('space-qualified Revision API', () => {
  let app;
  let server;
  let clients;
  let owner;
  let editor;
  let outsider;
  let spaceId;
  let db;

  beforeAll(() => {
    ({ app, server, clients } = createTestApp());
  });

  beforeEach(async () => {
    process.env[FLAG] = 'true';
    const stamp = `${Date.now()}-${Math.random()}`;
    owner = await setupTestUser(`revision-space-owner-${stamp}@example.com`, 'password123');
    editor = await setupTestUser(`revision-space-editor-${stamp}@example.com`, 'password123');
    outsider = await setupTestUser(`revision-space-outsider-${stamp}@example.com`, 'password123');
    getAuthDb().prepare('UPDATE users SET name = ? WHERE id = ?').run('Owner Name', owner.userId);
    getAuthDb().prepare('UPDATE users SET name = ? WHERE id = ?').run('Editor Name', editor.userId);

    const created = createSpace({ actorUserId: owner.userId, name: 'Revision Space' });
    spaceId = created.spaceId;
    addEditorMember({ actorUserId: owner.userId, spaceId, userId: editor.userId });
    db = getDb(`space:${spaceId}`);
    db.prepare(`
      INSERT INTO notes (id, user_id, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'space-note',
      owner.userId,
      'Shared draft',
      '# shared original',
      '2026-08-18T18:00:00.000Z',
      '2026-08-18T18:00:00.000Z',
    );
  });

  afterEach(() => {
    clients.clear();
    const spacesDb = getSpacesDb();
    if (spaceId) {
      spacesDb.prepare('DELETE FROM space_members WHERE space_id = ?').run(spaceId);
      spacesDb.prepare('DELETE FROM space_invites WHERE space_id = ?').run(spaceId);
      spacesDb.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId);
      deleteTestDb(`space:${spaceId}`);
    }
    for (const user of [owner, editor, outsider]) {
      if (!user) continue;
      spacesDb.prepare('DELETE FROM space_user_versions WHERE user_id = ?').run(user.userId);
      cleanupTestUser(user.userId);
    }
    spaceId = null;
  });

  afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env[FLAG];
    else process.env[FLAG] = ORIGINAL_FLAG;
    return new Promise((resolve) => server.close(resolve));
  });

  it('lets active members create/list/read revisions with server-derived actor display', async () => {
    const createResponse = await request(app)
      .post(`/notes/space-note/revisions?space=${spaceId}`)
      .set('Authorization', `Bearer ${getTestToken(owner.userId)}`)
      .send({ actorUserId: editor.userId, actorKind: 'collab' })
      .expect(201);

    const stored = db.prepare(
      'SELECT actor_user_id, actor_kind FROM note_revisions WHERE id = ?',
    ).get(createResponse.body.revisionId);
    expect(stored).toEqual({ actor_user_id: owner.userId, actor_kind: 'system' });

    const listResponse = await request(app)
      .get(`/notes/space-note/revisions?space=${spaceId}`)
      .set('Authorization', `Bearer ${getTestToken(editor.userId)}`)
      .expect(200);

    expect(listResponse.body.revisions[0]).toMatchObject({
      id: createResponse.body.revisionId,
      actor: { id: owner.userId, name: 'Owner Name' },
      actorKind: 'system',
    });
    expect(JSON.stringify(listResponse.body)).not.toContain(owner.email);

    const detailResponse = await request(app)
      .get(`/notes/space-note/revisions/${createResponse.body.revisionId}?space=${spaceId}`)
      .set('Authorization', `Bearer ${getTestToken(editor.userId)}`)
      .expect(200);
    expect(detailResponse.body.revision).toMatchObject({
      content: '# shared original',
      actor: { id: owner.userId, name: 'Owner Name' },
    });
  });

  it('returns the same non-disclosing response for a nonmember, unknown space, and revoked member', async () => {
    const unknownSpaceId = '00000000-0000-4000-8000-000000000000';
    const expected = { error: 'Not found', code: 'SPACE_NOT_FOUND' };
    const snapshot = createRevisionSnapshot(db, {
      noteId: 'space-note',
      title: 'Shared draft',
      content: '# shared original',
      type: 'manual',
      actorUserId: owner.userId,
      actorKind: 'system',
    });
    const outsiderAuth = ['Authorization', `Bearer ${getTestToken(outsider.userId)}`];

    await request(app)
      .get(`/notes/space-note/revisions?space=${spaceId}`)
      .set(...outsiderAuth)
      .expect(404, expected);
    await request(app)
      .get(`/notes/space-note/revisions/${snapshot.revisionId}?space=${spaceId}`)
      .set(...outsiderAuth)
      .expect(404, expected);
    await request(app)
      .post(`/notes/space-note/revisions?space=${spaceId}`)
      .set(...outsiderAuth)
      .send({})
      .expect(404, expected);
    await request(app)
      .post(`/notes/space-note/revisions/${snapshot.revisionId}/restore?space=${spaceId}`)
      .set(...outsiderAuth)
      .send({})
      .expect(404, expected);

    await request(app)
      .get(`/notes/space-note/revisions?space=${unknownSpaceId}`)
      .set('Authorization', `Bearer ${getTestToken(owner.userId)}`)
      .expect(404, expected);

    removeEditorMember({ actorUserId: owner.userId, spaceId, userId: editor.userId });
    await request(app)
      .get(`/notes/space-note/revisions?space=${spaceId}`)
      .set('Authorization', `Bearer ${getTestToken(editor.userId)}`)
      .expect(404, expected);
  });

  it('attributes a restore to the authenticated member and pokes space subscribers', async () => {
    const snapshot = createRevisionSnapshot(db, {
      noteId: 'space-note',
      title: 'Shared draft',
      content: '# shared original',
      type: 'auto',
      actorUserId: owner.userId,
      actorKind: 'sync',
    });
    db.prepare('UPDATE notes SET content = ?, updated_at = ? WHERE id = ?')
      .run('# changed', '2026-08-18T19:00:00.000Z', 'space-note');

    const subscriber = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    };
    clients.set(subscriber, {
      userId: editor.userId,
      siteId: 'a'.repeat(32),
      subscriptions: new Map([[`space:${spaceId}`, 'b'.repeat(32)]]),
    });

    const response = await request(app)
      .post(`/notes/space-note/revisions/${snapshot.revisionId}/restore?space=${spaceId}`)
      .set('Authorization', `Bearer ${getTestToken(editor.userId)}`)
      .send({ actorUserId: owner.userId })
      .expect(200);

    const preRestore = db.prepare(
      'SELECT actor_user_id, actor_kind FROM note_revisions WHERE id = ?',
    ).get(response.body.preRestoreRevisionId);
    expect(preRestore).toEqual({ actor_user_id: editor.userId, actor_kind: 'system' });
    expect(db.prepare('SELECT content FROM notes WHERE id = ?').get('space-note').content)
      .toBe('# shared original');
    expect(subscriber.send).toHaveBeenCalledWith(JSON.stringify({
      v: 1,
      type: 'sync',
      payload: { dbKey: `space:${spaceId}` },
    }));
  });
});
