// /frontend/src/store/docStore.js
import { ref, computed } from "vue";
import { defineStore } from "pinia";
import { storeToRefs } from "pinia";
import { useStructureStore } from "./structureStore";
import { useMarkdownStore } from "./markdownStore";
import { useSyncStore } from "./syncStore";
import { useDraftStore } from "./draftStore";
import { useImportExportStore } from "./importExportStore";
import { useConflictStore } from "./conflictStore";
import { normalizeRecentDocument } from "../utils/recentDocuments.js";
import { hasDocumentContentChanged } from "../utils/documentPersistence.js";
import { mergeDashboardRows } from "../utils/syncRegistry.js";

export const useDocStore = defineStore("docStore", () => {
  const structureStore = useStructureStore();
  const markdownStore = useMarkdownStore();
  const syncStore = useSyncStore();
  const draftStore = useDraftStore();
  const importExportStore = useImportExportStore();
  const conflictStore = useConflictStore();
  const isSaving = ref(false);
  const recentDocVersion = ref(0);

  // Pull refs out of the other stores WITHOUT wrapping them in computed again
  const {
    selectedFileId,
    selectedFolderId,
    selectedDbKey,
    openFolders,
    rootItems,
    selectedFile,
    selectedFileContent,
    contentVersion,
  } = storeToRefs(structureStore);

  const { styles, printStyles } = storeToRefs(markdownStore);

  /**
   * True when the open document has local edits that differ from its base and
   * have not yet been persisted. Consumed by the editor's save-status surface.
   * See COLLAB-01.
   */
  const isDirty = computed(() => {
    const id = selectedFileId.value;
    if (!id) return false;
    const draft = draftStore.getDraft(id);
    if (draft === undefined) return false;
    const base = draftStore.getBase(id) ?? selectedFile.value?.content ?? "";
    return hasDocumentContentChanged(base, draft);
  });

  async function loadInitialData() {
    // This is now mainly for selecting a default file after the initial sync
    await structureStore.loadRootItems(); // Ensure root items are loaded
    if (structureStore.rootItems.length > 0 && !structureStore.selectedFileId) {
      const firstFile = structureStore.rootItems.find(
        (item) => item.type === "file" && item.dbKey === syncStore.personalDbKey,
      );
      if (firstFile) {
        structureStore.selectFile(firstFile.id, firstFile.dbKey);
      }
    }
  }
  async function refreshData() {
    console.info("[DocStore] Refreshing data after sync.");
    await structureStore.loadRootItems();
    if (structureStore.selectedFileId) {
      // This is the key change: explicitly re-fetch the current file's data
      await structureStore.reFetchSelectedFile();
    }
    await conflictStore.loadConflicts();
    recentDocVersion.value++;
  }

  async function resetStore() {
    await syncStore.resetDatabase();
    structureStore.resetStore();
    markdownStore.resetStyles();
    markdownStore.resetPrintStyles();
    console.info("All stores have been reset.");
  }

  /**
   * Recursive folder-path CTE shared by both dashboard queries, so a document's
   * displayed path is built the same way whichever scope loaded it.
   */
  const FOLDER_PATHS_CTE = `
            WITH RECURSIVE folder_paths AS (
                SELECT
                    id,
                    parent_id,
                    name,
                    name AS path
                FROM folders
                WHERE parent_id IS NULL

                UNION ALL

                SELECT
                    child.id,
                    child.parent_id,
                    child.name,
                    folder_paths.path || ' / ' || child.name AS path
                FROM folders AS child
                JOIN folder_paths ON folder_paths.id = child.parent_id
            )`;

  const DOCUMENT_COLUMNS = `
                notes.id,
                notes.title,
                notes.content,
                notes.updated_at,
                notes.created_at,
                notes.folder_id,
                notes.pinned,
                COALESCE(folder_paths.path, 'Root') AS folderPath`;

  /**
   * Most recently modified documents across every folder — the global Recent
   * Documents scope.
   *
   * @param {number} [limit] bounded result size; the dashboard filters in memory
   * @returns {Promise<object[]>} normalized documents, newest first
   */
  async function getRecentDocuments(limit = 50) {
    const query = `
            ${FOLDER_PATHS_CTE}

            SELECT
${DOCUMENT_COLUMNS}
            FROM notes
            LEFT JOIN folder_paths ON folder_paths.id = notes.folder_id
            ORDER BY datetime(notes.updated_at) DESC
        `;
    try {
      const groups = [];
      for (const entry of syncStore.databases.values()) {
        if (!entry.db) continue;
        try {
          groups.push({
            dbKey: entry.dbKey,
            name: entry.kind === 'space' ? entry.name : null,
            rows: await syncStore.repository(entry.dbKey).execute(query),
          });
        } catch (error) {
          console.error(`Failed to query recent Documents for ${entry.dbKey}:`, error);
        }
      }
      return mergeDashboardRows(groups, { limit }).map(normalizeRecentDocument);
    } catch (error) {
      console.error("Failed to get recent documents:", error);
      return [];
    }
  }

  /**
   * Documents assigned directly to one folder. Deliberately `folder_id = ?`
   * rather than a descendant walk: a folder dashboard shows that folder's own
   * documents, and a pinned document in a child folder appears only once that
   * child is opened.
   *
   * @param {string|null} folderId selected folder; `null` means the root scope
   * @param {number} [limit] bounded result size
   * @returns {Promise<object[]>} normalized documents, newest first
   */
  async function getFolderDocuments(folderId, dbKey, limit = 50) {
    if (!dbKey) throw new Error('Database scope is required for a folder dashboard.');
    const query = `
            ${FOLDER_PATHS_CTE}

            SELECT
${DOCUMENT_COLUMNS}
            FROM notes
            LEFT JOIN folder_paths ON folder_paths.id = notes.folder_id
            WHERE notes.folder_id IS ?
            ORDER BY datetime(notes.updated_at) DESC
        `;
    try {
      const entry = syncStore.databases.get(dbKey);
      const results = await syncStore.repository(dbKey).execute(query, [folderId ?? null]);
      return mergeDashboardRows([
        { dbKey, name: entry?.kind === 'space' ? entry.name : null, rows: results },
      ], { limit }).map(normalizeRecentDocument);
    } catch (error) {
      console.error("Failed to get folder documents:", error);
      return [];
    }
  }

  /**
   * Pin or unpin a document. `updated_at` moves with the change so the document
   * orders consistently in the dashboards and replicates as an ordinary document edit.
   *
   * @param {string} noteId
   * @param {boolean} pinned
   * @returns {Promise<void>} rejects so the caller can revert its optimistic state
   */
  async function setDocumentPinned(noteId, pinned, dbKey) {
    if (!noteId) throw new Error("A document id is required to change pin state.");
    if (!dbKey) throw new Error('Database scope is required to change pin state.');

    await syncStore.repository(dbKey).transaction((repo) => repo.exec(
      "UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ?",
      [pinned ? 1 : 0, new Date().toISOString(), noteId],
    ));

    if (selectedFile.value?.id === noteId) {
      selectedFile.value.pinned = pinned ? 1 : 0;
    }
    structureStore.markContentChanged();
  }

  async function updateFileContent(fileId, newContent, dbKey) {
    if (!dbKey) throw new Error('Database scope is required to update a Document.');
    isSaving.value = true; // <--- Set to true
    try {
      const now = new Date().toISOString();
      await syncStore.repository(dbKey).transaction(async (repo) => {
        await repo.exec(
          "UPDATE notes SET content = ?, updated_at = ? WHERE id = ?",
          [newContent, now, fileId],
        );
        await repo.exec(
          `INSERT INTO note_sync_base (note_id, content, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(note_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
          [fileId, newContent ?? "", now],
        );
      });
      draftStore.setBase(fileId, newContent);
      if (selectedFile.value?.id === fileId) {
        selectedFile.value.content = newContent; // Optimistic update
      }
      structureStore.markContentChanged();
    } finally {
      // Add a small delay so the user can actually see the "Saving" state flicker
      setTimeout(() => {
        isSaving.value = false;
      }, 300);
    }
  }

  return {
    // State & Getters (forwarded refs)
    selectedFileId,
    selectedFolderId,
    selectedDbKey,
    openFolders,
    styles,
    printStyles,
    rootItems,
    selectedFile,
    selectedFileContent,
    contentVersion,

    // Expose stores if you still need direct access
    structureStore,
    syncStore,
    markdownStore,

    // Actions from structureStore
    loadInitialData,
    resetStore,
    loadRootItems: structureStore.loadRootItems,
    getChildren: structureStore.getChildren,
    createFile: structureStore.createFile,
    createFolder: structureStore.createFolder,
    deleteItem: structureStore.deleteItem,
    renameItem: structureStore.renameItem,
    moveItem: structureStore.moveItem,
    selectFile: structureStore.selectFile,
    selectFolder: structureStore.selectFolder,
    toggleFolder: structureStore.toggleFolder,
    isFolderOpen: structureStore.isFolderOpen,
    duplicateFile: structureStore.duplicateFile,
    updateFileContent: updateFileContent, // structureStore.updateFileContent,

    // Actions from other stores
    exportJson: importExportStore.exportDataAsJsonString,
    exportZip: importExportStore.exportDataAsZip,
    importData: importExportStore.importData,
    exportStackEditJson: importExportStore.exportDataAsStackEditJsonString,
    importStackEditData: importExportStore.importStackEditData,
    importMarkdownFiles: importExportStore.importMarkdownFiles,
    importMarkdownDirectory: importExportStore.importMarkdownDirectory,
    importZipArchive: importExportStore.importZipArchive,

    updateStyle: markdownStore.updateStyle,
    getMarkdownIt: markdownStore.getMarkdownIt,
    updatePrintStyle: markdownStore.updatePrintStyle,
    getPrintMarkdownIt: markdownStore.getPrintMarkdownIt,
    getRecentDocuments,
    getFolderDocuments,
    setDocumentPinned,
    refreshData, // Expose the new function
    recentDocVersion,
    isSaving,
    isDirty,
  };
});
