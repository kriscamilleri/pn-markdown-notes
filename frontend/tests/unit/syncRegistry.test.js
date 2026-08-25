// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  clockStorageKey,
  isStorageQuotaError,
  mergeDashboardRows,
  migrateLegacyPersonalClock,
  projectSpaceOutgoingChanges,
  reconcileMembershipKeys,
  runSequentially,
} from '@/utils/syncRegistry.js';
import { createDatabaseKey, localDatabaseName, parseDatabaseKey } from '@/utils/databaseKey.js';
import { createScopedRepository } from '@/utils/scopedRepository.js';

const harness = vi.hoisted(() => ({
  auth: {
    isAuthenticated: true,
    user: { id: '11111111-1111-4111-8111-111111111111', name: 'Personal User' },
    token: 'token',
    refreshToken: vi.fn(async () => false),
  },
  open: vi.fn(),
  refreshData: vi.fn(async () => {}),
  loadGlobals: vi.fn(async () => {}),
}));

vi.mock('@/vendor/crsqlite-wasm/index.js', () => ({
  default: vi.fn(async () => ({ open: harness.open })),
}));
vi.mock('@/store/authStore', () => ({ useAuthStore: () => harness.auth }));
vi.mock('@/store/docStore', () => ({ useDocStore: () => ({ refreshData: harness.refreshData }) }));
vi.mock('@/store/globalVariablesStore', () => ({
  useGlobalVariablesStore: () => ({ loadGlobals: harness.loadGlobals }),
}));

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(value) { this.sent.push(JSON.parse(value)); }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  message(value) { return this.onmessage?.({ data: JSON.stringify(value) }); }
}

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  };
}

function fakeDatabase(siteId) {
  const database = {
    siteId,
    exec: vi.fn(async () => {}),
    execO: vi.fn(async (sql) => {
      if (sql.includes('crsql_site_id')) return [{ id: siteId }];
      if (sql.includes('crsql_changes')) return [];
      if (sql.includes("PRAGMA table_info('notes')")) return [{ name: 'pinned' }];
      if (sql.includes("PRAGMA table_info('images')")) return [
        { name: 'size_bytes' }, { name: 'sha256' },
      ];
      if (sql.includes("PRAGMA table_info('globals')")) return [
        { name: 'key' }, { name: 'id' }, { name: 'created_at' },
        { name: 'updated_at' }, { name: 'display_key' },
      ];
      if (sql.includes("PRAGMA table_info('templates')")) return [
        { name: 'name', notnull: 1, dflt_value: "''" },
        { name: 'title_pattern' }, { name: 'default_folder_id' },
      ];
      if (sql.includes("PRAGMA index_list('globals')")) return [];
      if (sql.includes("sqlite_master")) return [];
      if (sql.includes('COUNT(*) AS cnt FROM templates')) return [{ cnt: 1 }];
      return [];
    }),
    onUpdate: vi.fn((handler) => { database.updateHandler = handler; }),
    close: vi.fn(async () => {}),
  };
  return database;
}

const { useSyncStore } = await import('@/store/syncStore.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const PERSONAL_KEY = `user:${USER_ID}`;
const SPACE_KEY = `space:${SPACE_ID}`;

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.clearAllMocks();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
});

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
}

describe('canonical database keys', () => {
  it('builds, parses, and names only canonical scoped keys', () => {
    expect(createDatabaseKey('user', USER_ID)).toBe(PERSONAL_KEY);
    expect(parseDatabaseKey(SPACE_KEY)).toEqual({ dbKey: SPACE_KEY, kind: 'space', id: SPACE_ID });
    expect(localDatabaseName(PERSONAL_KEY)).toBe(`panino-${USER_ID}.db`);
    expect(localDatabaseName(SPACE_KEY)).toBe(`panino-space-${SPACE_ID}.db`);
    expect(() => parseDatabaseKey(USER_ID)).toThrow(/canonical/);
  });
});

describe('clock migration', () => {
  it('moves the legacy personal clock once without replacing an existing scoped clock', () => {
    const legacy = storage({ crsqlite_clock: '41' });
    expect(migrateLegacyPersonalClock(legacy, PERSONAL_KEY)).toBe(41);
    expect(legacy.getItem(clockStorageKey(PERSONAL_KEY))).toBe('41');
    expect(legacy.getItem('crsqlite_clock')).toBeNull();

    legacy.setItem('crsqlite_clock', '99');
    expect(migrateLegacyPersonalClock(legacy, PERSONAL_KEY)).toBe(41);
    expect(legacy.getItem(clockStorageKey(PERSONAL_KEY))).toBe('41');
    expect(legacy.getItem('crsqlite_clock')).toBeNull();
  });
});

describe('sequential registry work', () => {
  it('keeps ordering and continues after one database fails', async () => {
    const active = [];
    let concurrent = 0;
    let maximumConcurrent = 0;
    const results = await runSequentially([PERSONAL_KEY, SPACE_KEY, 'tail'], async (key) => {
      concurrent++;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      active.push(key);
      await Promise.resolve();
      concurrent--;
      if (key === SPACE_KEY) throw new Error('reset');
      return key;
    });

    expect(active).toEqual([PERSONAL_KEY, SPACE_KEY, 'tail']);
    expect(maximumConcurrent).toBe(1);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});

describe('membership and dashboard helpers', () => {
  it('projects outgoing shared-space changes onto the server allowlist', () => {
    const changes = [
      { table: 'notes', cid: 'title', val: 'Draft' },
      { table: 'notes', cid: 'user_id', val: null },
      { table: 'folders', cid: 'user_id', val: null },
      { table: 'folders', cid: 'name', val: 'Ideas' },
      { table: 'users', cid: 'name', val: 'Server profile' },
      { table: 'images', cid: 'filename', val: 'server-owned.png' },
      { table: 'notes', cid: '-1', val: null },
    ];

    expect(projectSpaceOutgoingChanges(changes)).toEqual([
      changes[0],
      changes[3],
      changes[6],
    ]);
    expect(changes).toHaveLength(7);
  });

  it('identifies revoked space databases while retaining personal state', () => {
    const otherSpace = 'space:33333333-3333-4333-8333-333333333333';
    const result = reconcileMembershipKeys([PERSONAL_KEY, SPACE_KEY, otherSpace], PERSONAL_KEY, [
      { spaceId: SPACE_ID },
    ]);
    expect([...result.desired]).toEqual([PERSONAL_KEY, SPACE_KEY]);
    expect(result.revoked).toEqual([otherSpace]);
  });

  it('sorts and limits only after merging database rows', () => {
    const merged = mergeDashboardRows([
      { dbKey: PERSONAL_KEY, rows: [{ id: 'personal-old', updated_at: '2026-01-01T00:00:00Z' }] },
      { dbKey: SPACE_KEY, name: 'Writers', rows: [
        { id: 'space-new', updated_at: '2026-03-01T00:00:00Z' },
        { id: 'space-mid', updated_at: '2026-02-01T00:00:00Z' },
      ] },
    ], { limit: 2 });
    expect(merged.map((row) => row.id)).toEqual(['space-new', 'space-mid']);
    expect(merged[0]).toMatchObject({ dbKey: SPACE_KEY, spaceName: 'Writers' });
  });
});

describe('scoped repositories', () => {
  it('fails loudly for missing scope and rolls back failed transactions', async () => {
    expect(() => createScopedRepository(undefined, () => null)).toThrow(/scope is required/i);

    const exec = vi.fn(async () => {});
    const repository = createScopedRepository(PERSONAL_KEY, () => ({ exec, execO: vi.fn() }));
    await expect(repository.transaction(async () => { throw new Error('write failed'); }))
      .rejects.toThrow('write failed');
    expect(exec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('recognizes recoverable quota errors without classifying ordinary failures', () => {
    expect(isStorageQuotaError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isStorageQuotaError(new Error('network'))).toBe(false);
  });
});

describe('syncStore registry integration', () => {
  it('opens personal first, migrates its clock, and uses the database-owned site id', async () => {
    localStorage.setItem('crsqlite_clock', '17');
    const personalDb = fakeDatabase('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    harness.open.mockResolvedValue(personalDb);
    vi.stubGlobal('fetch', vi.fn(async () => response(404, { code: 'SPACE_NOT_FOUND' })));

    const store = useSyncStore();
    await store.initializeDB();

    expect(harness.open).toHaveBeenCalledTimes(1);
    expect(harness.open.mock.calls[0][0]).toBe(`panino-${USER_ID}.db`);
    expect(store.databases.get(PERSONAL_KEY)).toMatchObject({
      dbKey: PERSONAL_KEY,
      siteId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      clock: 17,
    });
    expect(localStorage.getItem('crsqlite_clock')).toBeNull();
    expect(localStorage.getItem(`crsqlite_clock:${PERSONAL_KEY}`)).toBe('17');
  });

  it('discovers paginated memberships and bootstraps spaces one at a time', async () => {
    const secondSpaceId = '33333333-3333-4333-8333-333333333333';
    const secondKey = `space:${secondSpaceId}`;
    const opened = [];
    harness.open.mockImplementation(async (name) => {
      opened.push(name);
      if (name.includes(SPACE_ID)) return fakeDatabase('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      if (name.includes(secondSpaceId)) return fakeDatabase('cccccccccccccccccccccccccccccccc');
      return fakeDatabase('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      if (url.includes('/spaces') && url.includes('cursor=')) {
        return response(200, {
          spaces: [{ spaceId: secondSpaceId, name: 'Editors', role: 'editor', members: [] }],
          membershipVersion: 3,
          minimum_client_schema: 1,
          nextCursor: null,
        });
      }
      if (url.includes('/spaces')) {
        return response(200, {
          spaces: [{ spaceId: SPACE_ID, name: 'Writers', role: 'owner', members: [] }],
          membershipVersion: 3,
          minimum_client_schema: 1,
          nextCursor: 'page-2',
        });
      }
      const body = JSON.parse(options.body);
      return response(200, {
        changes: [],
        clock: body.space === SPACE_ID ? 11 : 22,
        membershipVersion: 3,
      });
    }));

    const store = useSyncStore();
    await store.initializeDB();
    await vi.waitFor(() => expect(store.bootstrapState.status).toBe('ready'));

    expect(opened).toEqual([
      `panino-${USER_ID}.db`,
      `panino-space-${SPACE_ID}.db`,
      `panino-space-${secondSpaceId}.db`,
    ]);
    expect(store.databases.get(SPACE_KEY)).toMatchObject({ siteId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', clock: 11 });
    expect(store.databases.get(secondKey)).toMatchObject({ siteId: 'cccccccccccccccccccccccccccccccc', clock: 22 });
  });

  it('continues sequential sync after one database fails without advancing its clock', async () => {
    const personalDb = fakeDatabase('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const spaceDb = fakeDatabase('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    harness.open.mockImplementation(async (name) => name.includes('space-') ? spaceDb : personalDb);
    let discoveryCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      if (url.includes('/spaces')) {
        discoveryCount++;
        return response(200, {
          spaces: [{ spaceId: SPACE_ID, name: 'Writers', role: 'editor', members: [] }],
          membershipVersion: 1,
          minimum_client_schema: 1,
          nextCursor: null,
        });
      }
      const body = JSON.parse(options.body);
      if (body.space) return response(200, { changes: [], clock: 4, membershipVersion: 1 });
      return response(503, { code: 'SYNC_CONNECTION_RESET' });
    }));
    const store = useSyncStore();
    await store.initializeDB();
    await vi.waitFor(() => expect(store.bootstrapState.status).toBe('ready'));
    localStorage.setItem(`crsqlite_clock:${PERSONAL_KEY}`, '2');
    store.databases.get(PERSONAL_KEY).clock = 2;
    store.databases.get(SPACE_KEY).clock = 3;

    await store.sync();

    expect(store.databases.get(PERSONAL_KEY).clock).toBe(2);
    expect(store.databases.get(SPACE_KEY).clock).toBe(4);
    expect(discoveryCount).toBeGreaterThan(0);
  });

  it('surfaces quota failure and retries the failed space without blocking personal data', async () => {
    let failQuota = true;
    harness.open.mockImplementation(async (name) => {
      if (name.includes('space-') && failQuota) {
        failQuota = false;
        throw new DOMException('full', 'QuotaExceededError');
      }
      return fakeDatabase(name.includes('space-')
        ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        : 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });
    vi.stubGlobal('fetch', vi.fn(async (url) => url.includes('/spaces')
      ? response(200, {
          spaces: [{ spaceId: SPACE_ID, name: 'Writers', role: 'editor', members: [] }],
          membershipVersion: 1,
          minimum_client_schema: 1,
          nextCursor: null,
        })
      : response(200, { changes: [], clock: 1, membershipVersion: 1 })));

    const store = useSyncStore();
    await store.initializeDB();
    await vi.waitFor(() => expect(store.bootstrapState.status).toBe('quota-error'));
    expect(store.isInitialized).toBe(true);
    expect(store.databases.get(PERSONAL_KEY)?.db).toBeTruthy();
    expect(store.databases.get(SPACE_KEY)).toMatchObject({ db: null, status: 'quota-error' });

    await store.retryBootstrap(SPACE_KEY);
    expect(store.bootstrapState.status).toBe('ready');
    expect(store.databases.get(SPACE_KEY)).toMatchObject({ status: 'ready', clock: 1 });
  });

  it('continues one-at-a-time bootstrap after one space hits quota', async () => {
    const secondSpaceId = '33333333-3333-4333-8333-333333333333';
    const secondKey = `space:${secondSpaceId}`;
    harness.open.mockImplementation(async (name) => {
      if (name.includes(SPACE_ID)) throw new DOMException('full', 'QuotaExceededError');
      return fakeDatabase(name.includes(secondSpaceId)
        ? 'cccccccccccccccccccccccccccccccc'
        : 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });
    vi.stubGlobal('fetch', vi.fn(async (url) => url.includes('/spaces')
      ? response(200, {
          spaces: [
            { spaceId: SPACE_ID, name: 'Full', role: 'editor', members: [] },
            { spaceId: secondSpaceId, name: 'Available', role: 'editor', members: [] },
          ],
          membershipVersion: 1,
          minimum_client_schema: 1,
          nextCursor: null,
        })
      : response(200, { changes: [], clock: 8, membershipVersion: 1 })));

    const store = useSyncStore();
    await store.initializeDB();
    await vi.waitFor(() => expect(store.bootstrapState.completed).toBe(2));

    expect(store.bootstrapState.status).toBe('quota-error');
    expect(store.databases.get(SPACE_KEY)).toMatchObject({ db: null, status: 'quota-error' });
    expect(store.databases.get(secondKey)).toMatchObject({ status: 'ready', clock: 8 });
  });

  it('subscribes only initialized database site ids and resubscribes after reconnect', async () => {
    harness.open.mockImplementation(async (name) => fakeDatabase(name.includes('space-')
      ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      : 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    vi.stubGlobal('fetch', vi.fn(async (url) => url.includes('/spaces')
      ? response(200, {
          spaces: [{ spaceId: SPACE_ID, name: 'Writers', role: 'editor', members: [] }],
          membershipVersion: 1,
          minimum_client_schema: 1,
          nextCursor: null,
        })
      : response(200, { changes: [], clock: 1, membershipVersion: 1 })));

    const store = useSyncStore();
    await store.initializeDB();
    await vi.waitFor(() => expect(store.bootstrapState.status).toBe('ready'));
    const first = FakeWebSocket.instances[0];
    first.open();
    expect(first.sent.at(-1).payload.databases).toEqual([
      { dbKey: PERSONAL_KEY, siteId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { dbKey: SPACE_KEY, siteId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    ]);

    store.disconnectWebSocket();
    store.connectWebSocket();
    const second = FakeWebSocket.instances.at(-1);
    second.open();
    expect(second.sent.at(-1).payload.databases).toEqual(first.sent.at(-1).payload.databases);
  });

  it('routes WebSocket pokes by dbKey and refreshes changed subscribe membership versions', async () => {
    harness.open.mockImplementation(async (name) => fakeDatabase(name.includes('space-')
      ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      : 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    let discoveryCount = 0;
    const fetchSpy = vi.fn(async (url, options = {}) => {
      if (url.includes('/spaces')) {
        discoveryCount++;
        return response(200, {
          spaces: [{ spaceId: SPACE_ID, name: 'Writers', role: 'editor', members: [] }],
          membershipVersion: discoveryCount,
          minimum_client_schema: 1,
          nextCursor: null,
        });
      }
      const body = JSON.parse(options.body);
      return response(200, {
        changes: [],
        clock: body.space ? 9 : 7,
        membershipVersion: 2,
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const store = useSyncStore();
    await store.initializeDB();
    await vi.waitFor(() => expect(store.bootstrapState.status).toBe('ready'));
    const socket = FakeWebSocket.instances[0];
    socket.open();

    const beforeSubscribeResponse = discoveryCount;
    await socket.message({
      v: 1,
      type: 'subscribe',
      requestId: '44444444-4444-4444-8444-444444444444',
      ok: true,
      payload: { subscriptions: [], membershipVersion: 3 },
    });
    expect(discoveryCount).toBeGreaterThan(beforeSubscribeResponse);

    fetchSpy.mockClear();
    await socket.message({ v: 1, type: 'sync', payload: { dbKey: SPACE_KEY } });
    const syncBodies = fetchSpy.mock.calls
      .filter(([url]) => url.includes('/sync'))
      .map(([, options]) => JSON.parse(options.body));
    expect(syncBodies).toHaveLength(1);
    expect(syncBodies[0].space).toBe(SPACE_ID);
  });

  it('removes revoked registry entries and clears queued work before another retry', async () => {
    const spaceDb = fakeDatabase('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    harness.open.mockImplementation(async (name) => name.includes('space-')
      ? spaceDb
      : fakeDatabase('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    let revoked = false;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('/spaces')) {
        return response(200, {
          spaces: revoked ? [] : [{ spaceId: SPACE_ID, name: 'Writers', role: 'editor', members: [] }],
          membershipVersion: revoked ? 2 : 1,
          minimum_client_schema: 1,
          nextCursor: null,
        });
      }
      return response(200, { changes: [], clock: 1, membershipVersion: 1 });
    }));

    const store = useSyncStore();
    await store.initializeDB();
    await vi.waitFor(() => expect(store.bootstrapState.status).toBe('ready'));
    const entry = store.databases.get(SPACE_KEY);
    entry.syncPending = true;
    FakeWebSocket.instances[0].open();

    revoked = true;
    await store.refreshMembership();

    expect(entry.syncPending).toBe(false);
    expect(spaceDb.close).toHaveBeenCalled();
    expect(store.databases.has(SPACE_KEY)).toBe(false);
    expect(FakeWebSocket.instances[0].sent.some(
      (message) => message.type === 'unsubscribe' && message.payload.dbKeys[0] === SPACE_KEY,
    )).toBe(true);
  });
});
