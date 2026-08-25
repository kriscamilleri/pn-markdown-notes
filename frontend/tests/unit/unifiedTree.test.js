import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, defineStore, setActivePinia } from 'pinia';
import { ref } from 'vue';
import { mergeDashboardRows } from '@/utils/syncRegistry.js';

const USER_KEY = 'user:11111111-1111-4111-8111-111111111111';
const SPACE_KEY = 'space:22222222-2222-4222-8222-222222222222';
const calls = [];
const rowsByDb = new Map();

function createRepository(dbKey) {
  const execute = vi.fn(async (sql, params = []) => {
    calls.push({ dbKey, kind: 'read', sql, params });
    const rows = rowsByDb.get(dbKey) || {};
    if (sql.includes('parent_id IS NULL')) return rows.root || [];
    if (sql.includes('parent_id = ?')) return rows.children?.[params[0]] || [];
    if (sql.includes('SELECT * FROM notes') || sql.includes('SELECT title FROM notes')) return rows.notes || [];
    if (sql.includes('old_parent_id')) return [{ old_parent_id: null }];
    return [];
  });
  const exec = vi.fn(async (sql, params = []) => {
    calls.push({ dbKey, kind: 'write', sql, params });
  });
  return {
    execute,
    exec,
    transaction: async (work) => work({ dbKey, execute, exec }),
  };
}

const repositories = new Map([
  [USER_KEY, createRepository(USER_KEY)],
  [SPACE_KEY, createRepository(SPACE_KEY)],
]);

vi.mock('@/store/syncStore', () => ({
  useSyncStore: defineStore('syncStore', () => ({
    isInitialized: ref(true),
    personalDbKey: ref(USER_KEY),
    databases: ref(new Map([
      [USER_KEY, { dbKey: USER_KEY, kind: 'user', db: {}, name: 'Personal', status: 'ready' }],
      [SPACE_KEY, {
        dbKey: SPACE_KEY,
        kind: 'space',
        db: {},
        name: 'Writers',
        role: 'editor',
        members: [{ id: 'member-a', name: 'Alice' }],
        status: 'ready',
      }],
    ])),
    repository: (dbKey) => {
      const repo = repositories.get(dbKey);
      if (!repo) throw new Error(`missing ${dbKey}`);
      return repo;
    },
  })),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: defineStore('authStore', () => ({
    user: ref({ id: '11111111-1111-4111-8111-111111111111', name: 'Personal User' }),
  })),
}));

const { useStructureStore } = await import('@/store/structureStore.js');

beforeEach(() => {
  setActivePinia(createPinia());
  calls.length = 0;
  for (const repo of repositories.values()) {
    repo.execute.mockClear();
    repo.exec.mockClear();
  }
  rowsByDb.set(USER_KEY, {
    root: [{ id: 'personal-folder', name: 'Private', type: 'folder' }],
    children: { 'personal-folder': [{ id: 'personal-note', name: 'Mine', type: 'file' }] },
    notes: [{ id: 'personal-note', title: 'Mine', content: 'private' }],
  });
  rowsByDb.set(SPACE_KEY, {
    root: [{ id: 'space-folder', name: 'Shared', type: 'folder' }],
    children: { 'space-folder': [{ id: 'space-note', name: 'Ours', type: 'file' }] },
    notes: [{ id: 'space-note', title: 'Ours', content: 'shared' }],
  });
});

describe('unified tree database routing', () => {
  it('keeps personal roots first and adds a member-labelled space root', async () => {
    const store = useStructureStore();
    await store.loadRootItems();

    expect(store.rootItems.map((item) => item.id)).toEqual(['personal-folder', SPACE_KEY]);
    expect(store.rootItems[1]).toMatchObject({
      type: 'space',
      dbKey: SPACE_KEY,
      name: 'Writers',
      members: [{ id: 'member-a', name: 'Alice' }],
    });
    expect(store.nodeDbIndex.get('personal-folder')).toBe(USER_KEY);
    expect(store.nodeDbIndex.get(SPACE_KEY)).toBe(SPACE_KEY);
  });

  it('indexes children and routes selection and rename to their owning database', async () => {
    const store = useStructureStore();
    await store.loadRootItems();
    const [spaceFolder] = await store.getChildren(SPACE_KEY, SPACE_KEY);
    const [spaceNote] = await store.getChildren(spaceFolder.id, SPACE_KEY);

    expect(spaceNote).toMatchObject({ id: 'space-note', dbKey: SPACE_KEY, spaceName: 'Writers' });
    store.selectFile(spaceNote.id, SPACE_KEY);
    await Promise.resolve();
    await store.renameItem(spaceNote.id, 'Renamed', 'file', SPACE_KEY);

    expect(store.selectedDbKey).toBe(SPACE_KEY);
    expect(calls.some((call) => call.dbKey === SPACE_KEY && call.sql.includes('UPDATE notes SET title'))).toBe(true);
    expect(calls.some((call) => call.dbKey === USER_KEY && call.sql.includes('UPDATE notes SET title'))).toBe(false);
  });

  it('preserves same-database moves and requires confirmation for a cross-database Document transfer', async () => {
    const store = useStructureStore();
    await store.loadRootItems();
    await store.getChildren(SPACE_KEY, SPACE_KEY);
    await store.getChildren('space-folder', SPACE_KEY);
    await expect(store.moveItem('space-note', 'space-folder', 'file', SPACE_KEY)).resolves.toMatchObject({ dbKey: SPACE_KEY });

    await store.getChildren('personal-folder', USER_KEY);
    await expect(store.moveItem('personal-note', 'space-folder', 'file', SPACE_KEY))
      .resolves.toMatchObject({
        requiresConfirmation: true,
        sourceDbKey: USER_KEY,
        destinationDbKey: SPACE_KEY,
        sourceNoteId: 'personal-note',
        destinationFolderId: 'space-folder',
        documentName: 'Mine',
      });
  });

  it('fails loudly when a public operation has no database scope', async () => {
    const store = useStructureStore();
    await expect(store.createFile(undefined, 'Unscoped')).rejects.toThrow(/scope/i);
    expect(() => store.selectFile('unknown-note', undefined)).toThrow(/scope/i);
  });
});

describe('dashboard aggregation', () => {
  it('merges, tags, sorts, then limits across personal and shared databases', () => {
    const rows = mergeDashboardRows([
      { dbKey: USER_KEY, rows: [{ id: 'personal', updated_at: '2026-08-01T00:00:00Z' }] },
      { dbKey: SPACE_KEY, name: 'Writers', rows: [
        { id: 'shared-latest', updated_at: '2026-08-03T00:00:00Z' },
        { id: 'shared-middle', updated_at: '2026-08-02T00:00:00Z' },
      ] },
    ], { limit: 2 });

    expect(rows.map((row) => row.id)).toEqual(['shared-latest', 'shared-middle']);
    expect(rows[0]).toMatchObject({ dbKey: SPACE_KEY, spaceName: 'Writers' });
  });
});
