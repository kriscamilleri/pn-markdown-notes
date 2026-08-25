import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  cleanupTestUser,
  createTestApp,
  getTestToken,
  setupTestUser,
} from '../testHelpers.js';
import { deleteTestDb, getSpacesDb } from '../../db.js';
import { addEditorMember, createSpace } from '../../spaces.js';

const FLAG = 'SHARED_SPACES_ENABLED';
const ORIGINAL_FLAG = process.env[FLAG];

describe('GET /spaces membership discovery', () => {
  let app;
  let server;
  let owner;
  let editor;
  let outsider;
  let createdSpaceIds;

  beforeAll(() => {
    ({ app, server } = createTestApp());
  });

  beforeEach(async () => {
    process.env[FLAG] = 'true';
    const stamp = `${Date.now()}-${Math.random()}`;
    owner = await setupTestUser(`discovery-owner-${stamp}@example.com`, 'password123');
    editor = await setupTestUser(`discovery-editor-${stamp}@example.com`, 'password123');
    outsider = await setupTestUser(`discovery-outsider-${stamp}@example.com`, 'password123');
    createdSpaceIds = [];
  });

  afterEach(() => {
    const db = getSpacesDb();
    for (const spaceId of createdSpaceIds) {
      db.prepare('DELETE FROM space_members WHERE space_id = ?').run(spaceId);
      db.prepare('DELETE FROM space_invites WHERE space_id = ?').run(spaceId);
      db.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId);
      deleteTestDb(`space:${spaceId}`);
    }
    for (const user of [owner, editor, outsider]) {
      if (!user) continue;
      db.prepare('DELETE FROM space_user_versions WHERE user_id = ?').run(user.userId);
      cleanupTestUser(user.userId);
    }
  });

  afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env[FLAG];
    else process.env[FLAG] = ORIGINAL_FLAG;
    return new Promise((resolve) => server.close(resolve));
  });

  function createNamedSpace(name) {
    const created = createSpace({ actorUserId: owner.userId, name });
    createdSpaceIds.push(created.spaceId);
    addEditorMember({ actorUserId: owner.userId, spaceId: created.spaceId, userId: editor.userId });
    return created;
  }

  it('returns only the actor memberships with profile-safe member data', async () => {
    const joined = createNamedSpace('Writers');
    const second = createNamedSpace('Second');
    const spacesDb = getSpacesDb();
    spacesDb.prepare('UPDATE spaces SET created_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', joined.spaceId);
    spacesDb.prepare('UPDATE spaces SET created_at = ? WHERE id = ?')
      .run('2026-01-02T00:00:00.000Z', second.spaceId);

    const response = await request(app)
      .get('/spaces?limit=1')
      .set('Authorization', `Bearer ${getTestToken(editor.userId)}`)
      .expect(200);

    expect(response.body.spaces).toHaveLength(1);
    expect(response.body.spaces[0]).toMatchObject({ spaceId: joined.spaceId, name: 'Writers', role: 'editor' });
    expect(response.body.spaces[0].members).toEqual([
      { id: owner.userId, name: 'Test User' },
      { id: editor.userId, name: 'Test User' },
    ]);
    expect(JSON.stringify(response.body)).not.toContain(owner.email);
    expect(response.body.membershipVersion).toBeGreaterThan(0);
    expect(response.body.minimum_client_schema).toBe(1);
    expect(response.body.nextCursor).toEqual(expect.any(String));

    const next = await request(app)
      .get(`/spaces?limit=1&cursor=${encodeURIComponent(response.body.nextCursor)}`)
      .set('Authorization', `Bearer ${getTestToken(editor.userId)}`)
      .expect(200);
    expect(next.body.spaces).toHaveLength(1);
    expect(next.body.spaces[0].spaceId).not.toBe(joined.spaceId);
    expect(next.body.nextCursor).toBeNull();

    const hidden = await request(app)
      .get('/spaces')
      .set('Authorization', `Bearer ${getTestToken(outsider.userId)}`)
      .expect(200);
    expect(hidden.body.spaces).toEqual([]);
  });

  it('fails closed while disabled and rejects malformed cursors safely', async () => {
    delete process.env[FLAG];
    await request(app)
      .get('/spaces')
      .set('Authorization', `Bearer ${getTestToken(editor.userId)}`)
      .expect(404, { error: 'Not found', code: 'SPACE_NOT_FOUND' });

    process.env[FLAG] = 'true';
    await request(app)
      .get('/spaces?cursor=not-a-cursor')
      .set('Authorization', `Bearer ${getTestToken(editor.userId)}`)
      .expect(400, { error: 'Invalid cursor', code: 'INVALID_SPACE_CURSOR' });
  });

  it('requires authentication', async () => {
    await request(app).get('/spaces').expect(401);
  });
});
