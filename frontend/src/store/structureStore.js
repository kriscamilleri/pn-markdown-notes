import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { v4 as uuidv4 } from 'uuid';
import { useAuthStore } from './authStore';
import { useSyncStore } from './syncStore';
import { parseDatabaseKey } from '@/utils/databaseKey';

const ROOT_QUERY = `
  SELECT id, name, 'folder' AS type FROM folders WHERE parent_id IS NULL
  UNION ALL
  SELECT id, title AS name, 'file' AS type FROM notes WHERE folder_id IS NULL
  ORDER BY type DESC, name
`.trim();

const CHILD_QUERY = `
  SELECT id, name, 'folder' AS type FROM folders WHERE parent_id = ?
  UNION ALL
  SELECT id, title AS name, 'file' AS type FROM notes WHERE folder_id = ?
  ORDER BY type DESC, name
`.trim();

export const useStructureStore = defineStore('structureStore', () => {
  const syncStore = useSyncStore();
  const authStore = useAuthStore();
  const rootItems = ref([]);
  const selectedFileId = ref(null);
  const selectedFolderId = ref(null);
  const selectedDbKey = ref(null);
  const openFolders = ref(new Set());
  const selectedFile = ref(null);
  const nodeDbIndex = ref(new Map());
  const contentVersion = ref(0);

  const selectedFileContent = computed(() => selectedFile.value?.content || '');
  const selectedDatabase = computed(() => (
    selectedDbKey.value ? syncStore.databases.get(selectedDbKey.value) || null : null
  ));

  function markContentChanged() {
    contentVersion.value++;
  }

  function requireDbKey(dbKey) {
    parseDatabaseKey(dbKey);
    if (!syncStore.databases.has(dbKey)) throw new Error(`Database scope ${dbKey} is not registered.`);
    return dbKey;
  }

  function scopeForNode(nodeId, explicitDbKey = null) {
    const indexed = nodeDbIndex.value.get(nodeId);
    if (explicitDbKey && indexed && explicitDbKey !== indexed) {
      throw new Error(`Node ${nodeId} does not belong to database scope ${explicitDbKey}.`);
    }
    const dbKey = explicitDbKey || indexed;
    if (!dbKey) throw new Error(`Database scope is required for node ${nodeId}.`);
    return requireDbKey(dbKey);
  }

  function indexRows(rows, dbKey, metadata = {}) {
    return (rows || []).map((row) => {
      nodeDbIndex.value.set(row.id, dbKey);
      return { ...row, ...metadata, dbKey, treeKey: `${dbKey}:${row.id}` };
    });
  }

  watch(
    () => [syncStore.isInitialized, syncStore.databases.size],
    async ([ready]) => { if (ready) await loadRootItems(); },
    { immediate: true },
  );

  watch(
    () => [selectedFileId.value, selectedDbKey.value],
    async ([fileId, dbKey]) => {
      if (!fileId || !dbKey) {
        selectedFile.value = null;
        return;
      }
      const rows = await syncStore.repository(dbKey).execute('SELECT * FROM notes WHERE id = ?', [fileId]);
      const entry = syncStore.databases.get(dbKey);
      selectedFile.value = rows[0]
        ? {
            ...rows[0],
            dbKey,
            spaceName: entry?.kind === 'space' ? entry.name : null,
            visibility: entry?.kind === 'space' ? 'Shared with space members' : 'Private',
          }
        : null;
    },
    { immediate: true },
  );

  async function reFetchSelectedFile() {
    if (!selectedFileId.value || !selectedDbKey.value) return;
    const rows = await syncStore.repository(selectedDbKey.value).execute(
      'SELECT * FROM notes WHERE id = ?', [selectedFileId.value],
    );
    const entry = syncStore.databases.get(selectedDbKey.value);
    selectedFile.value = rows[0]
      ? {
          ...rows[0],
          dbKey: selectedDbKey.value,
          spaceName: entry?.kind === 'space' ? entry.name : null,
          visibility: entry?.kind === 'space' ? 'Shared with space members' : 'Private',
        }
      : null;
  }

  async function loadRootItems() {
    if (!syncStore.isInitialized || !syncStore.personalDbKey) return;
    nodeDbIndex.value = new Map();
    const personalRows = await syncStore.repository(syncStore.personalDbKey).execute(ROOT_QUERY);
    const personalItems = indexRows(personalRows, syncStore.personalDbKey, { visibility: 'Private' });
    const spaceRoots = [...syncStore.databases.values()]
      .filter((entry) => entry.kind === 'space')
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
      .map((entry) => {
        nodeDbIndex.value.set(entry.dbKey, entry.dbKey);
        return {
          id: entry.dbKey,
          treeKey: entry.dbKey,
          dbKey: entry.dbKey,
          type: 'space',
          name: entry.name,
          role: entry.role,
          members: entry.members || [],
          status: entry.status,
          error: entry.error,
          visibility: 'Shared with space members',
        };
      });
    rootItems.value = [...personalItems, ...spaceRoots];
  }

  async function getChildren(parentId, explicitDbKey = null) {
    if (!parentId) throw new Error('A parent node and database scope are required.');
    const dbKey = scopeForNode(parentId, explicitDbKey);
    const entry = syncStore.databases.get(dbKey);
    if (!entry?.db) return [];
    const rows = parentId === dbKey && entry.kind === 'space'
      ? await syncStore.repository(dbKey).execute(ROOT_QUERY)
      : await syncStore.repository(dbKey).execute(CHILD_QUERY, [parentId, parentId]);
    return indexRows(rows, dbKey, {
      spaceName: entry.kind === 'space' ? entry.name : null,
      visibility: entry.kind === 'space' ? 'Shared with space members' : 'Private',
    });
  }

  async function createFile(dbKey, name, parentId = null) {
    requireDbKey(dbKey);
    if (!authStore.user?.id) throw new Error('User is not authenticated.');
    if (parentId) scopeForNode(parentId, dbKey);
    const entry = syncStore.databases.get(dbKey);
    if (!entry?.db) throw new Error(`Database scope ${dbKey} is not ready.`);
    const now = new Date().toISOString();
    const note = {
      id: uuidv4(),
      folder_id: parentId === dbKey ? null : parentId,
      title: name,
      content: `# ${name}\n\n`,
      created_at: now,
      updated_at: now,
    };
    await syncStore.repository(dbKey).transaction(async (repo) => {
      if (entry.kind === 'user') {
        await repo.exec(
          'INSERT INTO notes (id, user_id, folder_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [note.id, authStore.user.id, note.folder_id, note.title, note.content, now, now],
        );
      } else {
        await repo.exec(
          'INSERT INTO notes (id, folder_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          [note.id, note.folder_id, note.title, note.content, now, now],
        );
      }
      await repo.exec(
        'INSERT OR IGNORE INTO note_sync_base (note_id, content, updated_at) VALUES (?, ?, ?)',
        [note.id, note.content, now],
      );
    });
    nodeDbIndex.value.set(note.id, dbKey);
    await loadRootItems();
    markContentChanged();
    return { id: note.id, type: 'file', name, dbKey, treeKey: `${dbKey}:${note.id}` };
  }

  async function createFolder(dbKey, name, parentId = null) {
    requireDbKey(dbKey);
    if (!authStore.user?.id) throw new Error('User is not authenticated.');
    const entry = syncStore.databases.get(dbKey);
    if (!entry?.db) throw new Error(`Database scope ${dbKey} is not ready.`);
    if (parentId) scopeForNode(parentId, dbKey);
    const id = uuidv4();
    const actualParent = parentId === dbKey ? null : parentId;
    const now = new Date().toISOString();
    await syncStore.repository(dbKey).transaction(async (repo) => {
      if (entry.kind === 'user') {
        await repo.exec(
          'INSERT INTO folders (id, user_id, parent_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
          [id, authStore.user.id, actualParent, name, now],
        );
      } else {
        await repo.exec(
          'INSERT INTO folders (id, parent_id, name, created_at) VALUES (?, ?, ?, ?)',
          [id, actualParent, name, now],
        );
      }
    });
    nodeDbIndex.value.set(id, dbKey);
    await loadRootItems();
    markContentChanged();
    return { id, type: 'folder', name, dbKey, treeKey: `${dbKey}:${id}` };
  }

  async function deleteItem(id, type, explicitDbKey) {
    const dbKey = scopeForNode(id, explicitDbKey);
    if (type === 'space') throw new Error('Removing a local space uses the recovery action.');
    if (type === 'folder') {
      const children = await getChildren(id, dbKey);
      for (const child of children) await deleteItem(child.id, child.type, dbKey);
    }
    await syncStore.repository(dbKey).transaction(async (repo) => {
      await repo.exec(type === 'folder' ? 'DELETE FROM folders WHERE id = ?' : 'DELETE FROM notes WHERE id = ?', [id]);
    });
    nodeDbIndex.value.delete(id);
    if (selectedFileId.value === id || selectedFolderId.value === id) {
      selectedFileId.value = null;
      selectedFolderId.value = null;
      selectedDbKey.value = null;
    }
    await loadRootItems();
    markContentChanged();
  }

  async function renameItem(id, newName, type, explicitDbKey) {
    const dbKey = scopeForNode(id, explicitDbKey);
    if (type === 'space') throw new Error('Space lifecycle changes are not available yet.');
    await syncStore.repository(dbKey).transaction(async (repo) => {
      if (type === 'folder') await repo.exec('UPDATE folders SET name = ? WHERE id = ?', [newName, id]);
      else await repo.exec('UPDATE notes SET title = ?, updated_at = ? WHERE id = ?', [newName, new Date().toISOString(), id]);
    });
    await loadRootItems();
    markContentChanged();
  }

  async function moveItem(itemId, newParentId, type, destinationDbKey) {
    const sourceDbKey = scopeForNode(itemId);
    const targetDbKey = newParentId
      ? scopeForNode(newParentId, destinationDbKey || null)
      : requireDbKey(destinationDbKey);
    if (sourceDbKey !== targetDbKey) {
      if (type !== 'file') {
        throw new Error('Folders cannot be moved between databases. Move Documents individually.');
      }
      const sourceRows = await syncStore.repository(sourceDbKey).execute(
        'SELECT title FROM notes WHERE id = ?',
        [itemId],
      );
      if (!sourceRows[0]) throw new Error('Source Document is no longer available.');
      const sourceEntry = syncStore.databases.get(sourceDbKey);
      const destinationEntry = syncStore.databases.get(targetDbKey);
      return {
        requiresConfirmation: true,
        sourceDbKey,
        destinationDbKey: targetDbKey,
        sourceNoteId: itemId,
        destinationFolderId: newParentId === targetDbKey ? null : newParentId,
        documentName: sourceRows[0].title || 'Untitled',
        sourceName: sourceEntry?.name || 'Personal',
        destinationName: destinationEntry?.name || 'Personal',
      };
    }
    const repository = syncStore.repository(sourceDbKey);
    const oldParentRows = await repository.execute(
      type === 'folder'
        ? 'SELECT parent_id AS old_parent_id FROM folders WHERE id = ?'
        : 'SELECT folder_id AS old_parent_id FROM notes WHERE id = ?',
      [itemId],
    );
    const parent = newParentId === targetDbKey ? null : newParentId;
    await repository.transaction(async (repo) => {
      await repo.exec(
        type === 'folder'
          ? 'UPDATE folders SET parent_id = ? WHERE id = ?'
          : 'UPDATE notes SET folder_id = ?, updated_at = ? WHERE id = ?',
        type === 'folder' ? [parent, itemId] : [parent, new Date().toISOString(), itemId],
      );
    });
    markContentChanged();
    return { oldParentId: oldParentRows[0]?.old_parent_id, dbKey: sourceDbKey };
  }

  function selectFile(fileId, dbKey) {
    scopeForNode(fileId, dbKey);
    selectedDbKey.value = dbKey;
    selectedFileId.value = fileId;
    selectedFolderId.value = null;
  }

  function selectFolder(folderId, dbKey) {
    requireDbKey(dbKey);
    if (folderId) scopeForNode(folderId, dbKey);
    selectedDbKey.value = dbKey;
    selectedFileId.value = null;
    selectedFolderId.value = folderId;
  }

  async function duplicateFile(fileId, dbKey) {
    scopeForNode(fileId, dbKey);
    const rows = await syncStore.repository(dbKey).execute('SELECT * FROM notes WHERE id = ?', [fileId]);
    if (!rows.length) throw new Error('Source Document not found.');
    const source = rows[0];
    const created = await createFile(dbKey, `${source.title || 'Untitled'} (copy)`, source.folder_id);
    await syncStore.repository(dbKey).transaction(async (repo) => {
      const now = new Date().toISOString();
      await repo.exec('UPDATE notes SET content = ?, updated_at = ? WHERE id = ?', [source.content, now, created.id]);
      await repo.exec('UPDATE note_sync_base SET content = ?, updated_at = ? WHERE note_id = ?', [source.content ?? '', now, created.id]);
    });
    return created;
  }

  function toggleFolder(folderId, dbKey) {
    scopeForNode(folderId, dbKey);
    const key = `${dbKey}:${folderId}`;
    const next = new Set(openFolders.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    openFolders.value = next;
  }

  function isFolderOpen(folderId, dbKey) {
    return openFolders.value.has(`${dbKey}:${folderId}`);
  }

  function clearDatabaseScope(dbKey) {
    parseDatabaseKey(dbKey);
    const nodeIds = [...nodeDbIndex.value.entries()]
      .filter(([, indexedDbKey]) => indexedDbKey === dbKey)
      .map(([nodeId]) => nodeId)
      .filter((nodeId) => nodeId !== dbKey);
    if (selectedDbKey.value === dbKey) {
      if (selectedFileId.value) nodeIds.push(selectedFileId.value);
      selectedFileId.value = null;
      selectedFolderId.value = null;
      selectedDbKey.value = null;
      selectedFile.value = null;
    }
    rootItems.value = rootItems.value.filter((item) => item.dbKey !== dbKey);
    nodeDbIndex.value = new Map(
      [...nodeDbIndex.value.entries()].filter(([, indexedDbKey]) => indexedDbKey !== dbKey),
    );
    openFolders.value = new Set(
      [...openFolders.value].filter((key) => !key.startsWith(`${dbKey}:`)),
    );
    return [...new Set(nodeIds)];
  }

  function resetStore() {
    rootItems.value = [];
    selectedFileId.value = null;
    selectedFolderId.value = null;
    selectedDbKey.value = null;
    openFolders.value = new Set();
    selectedFile.value = null;
    nodeDbIndex.value = new Map();
    contentVersion.value = 0;
  }

  return {
    rootItems,
    selectedFileId,
    selectedFolderId,
    selectedDbKey,
    selectedDatabase,
    openFolders,
    selectedFile,
    selectedFileContent,
    nodeDbIndex,
    contentVersion,
    markContentChanged,
    scopeForNode,
    loadRootItems,
    getChildren,
    createFile,
    createFolder,
    deleteItem,
    renameItem,
    moveItem,
    selectFile,
    selectFolder,
    duplicateFile,
    toggleFolder,
    isFolderOpen,
    clearDatabaseScope,
    reFetchSelectedFile,
    resetStore,
  };
});
