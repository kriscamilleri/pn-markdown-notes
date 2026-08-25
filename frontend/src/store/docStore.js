// /frontend/src/store/docStore.js
import { ref } from "vue";
import { defineStore } from "pinia";
import { storeToRefs } from "pinia";
import { useStructureStore } from "./structureStore";
import { useMarkdownStore } from "./markdownStore";
import { useSyncStore } from "./syncStore";
import { useImportExportStore } from "./importExportStore";
import { normalizeRecentDocument } from "../utils/recentDocuments.js";

export const useDocStore = defineStore("docStore", () => {
  const structureStore = useStructureStore();
  const markdownStore = useMarkdownStore();
  const syncStore = useSyncStore();
  const importExportStore = useImportExportStore();
  const isSaving = ref(false);
  const recentDocVersion = ref(0);

  // Pull refs out of the other stores WITHOUT wrapping them in computed again
  const {
    selectedFileId,
    selectedFolderId,
    openFolders,
    rootItems,
    selectedFile,
    selectedFileContent,
    contentVersion,
  } = storeToRefs(structureStore);

  const { styles, printStyles } = storeToRefs(markdownStore);

  async function loadInitialData() {
    // This is now mainly for selecting a default file after the initial sync
    await structureStore.loadRootItems(); // Ensure root items are loaded
    if (structureStore.rootItems.length > 0 && !structureStore.selectedFileId) {
      const firstFile = structureStore.rootItems.find(
        (item) => item.type === "file",
      );
      if (firstFile) {
        structureStore.selectFile(firstFile.id);
      }
    }
  }
  async function refreshData() {
    console.log("[DocStore] Refreshing data after sync.");
    await structureStore.loadRootItems();
    if (structureStore.selectedFileId) {
      // This is the key change: explicitly re-fetch the current file's data
      await structureStore.reFetchSelectedFile();
    }
    recentDocVersion.value++;
  }

  async function resetStore() {
    await syncStore.resetDatabase();
    structureStore.resetStore();
    markdownStore.resetStyles();
    markdownStore.resetPrintStyles();
    console.log("All stores have been reset.");
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
            LIMIT ?
        `;
    try {
      const results = await syncStore.execute(query, [limit]);
      return (results || []).map(normalizeRecentDocument);
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
  async function getFolderDocuments(folderId, limit = 50) {
    const query = `
            ${FOLDER_PATHS_CTE}

            SELECT
${DOCUMENT_COLUMNS}
            FROM notes
            LEFT JOIN folder_paths ON folder_paths.id = notes.folder_id
            WHERE notes.folder_id IS ?
            ORDER BY datetime(notes.updated_at) DESC
            LIMIT ?
        `;
    try {
      const results = await syncStore.execute(query, [folderId ?? null, limit]);
      return (results || []).map(normalizeRecentDocument);
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
  async function setDocumentPinned(noteId, pinned) {
    if (!noteId) throw new Error("A document id is required to change pin state.");

    await syncStore.db.value.exec(
      "UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ?",
      [pinned ? 1 : 0, new Date().toISOString(), noteId],
    );

    if (selectedFile.value?.id === noteId) {
      selectedFile.value.pinned = pinned ? 1 : 0;
    }
    structureStore.markContentChanged();
  }

  async function updateFileContent(fileId, newContent) {
    isSaving.value = true; // <--- Set to true
    try {
      await syncStore.db.value.exec(
        "UPDATE notes SET content = ?, updated_at = ? WHERE id = ?",
        [newContent, new Date().toISOString(), fileId],
      );
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
    listMarkdownDocumentsInDirectory: importExportStore.listMarkdownDocumentsInDirectory,
    importDocumentWithLinkedImages: importExportStore.importDocumentWithLinkedImages,
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
  };
});
