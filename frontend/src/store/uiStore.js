// /frontend/src/store/uiStore.js
import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { useSyncStore } from "./syncStore";
import { useAuthStore } from "./authStore";

export const useUiStore = defineStore("uiStore", () => {
  const syncStore = useSyncStore();
  const authStore = useAuthStore();

  // --- Reactive State ---
  const showDocuments = ref(true);
  const showEditor = ref(true);
  const showPreview = ref(true);
  const showStats = ref(false);
  const showMetadata = ref(false);
  const editorMenuCollapsed = ref(false);
  const viewMenuCollapsed = ref(false);
  const toolsMenuCollapsed = ref(false);
  const navbarCollapsed = ref(false);
  const scrollSync = ref(false);

  // Menu visibility (transient, not persisted)
  const showViewMenu = ref(false);
  const showActionBar = ref(false);
  const showFileMenu = ref(false);

  // Modal and Toast state (transient)
  const showImportModal = ref(false);
  const showExportModal = ref(false);
  const showGithubBackupModal = ref(false);
  const showVariablesModal = ref(false);
  const showImageLibraryModal = ref(false);
  const toasts = ref([]);

  let settingsLoaded = false;

  // --- Persistence ---

  const debounce = (fn, wait = 500) => {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), wait);
    };
  };

  const saveSettingsToDB = debounce(async () => {
    if (!settingsLoaded || !syncStore.isInitialized) return;
    const settings = {
      showDocuments: showDocuments.value,
      showEditor: showEditor.value,
      showPreview: showPreview.value,
      showStats: showStats.value,
      showMetadata: showMetadata.value,
      editorMenuCollapsed: editorMenuCollapsed.value,
      viewMenuCollapsed: viewMenuCollapsed.value,
      toolsMenuCollapsed: toolsMenuCollapsed.value,
      navbarCollapsed: navbarCollapsed.value,
      scrollSync: scrollSync.value,
    };
    try {
      await syncStore.personalRepository().exec(
        `INSERT OR REPLACE INTO settings (id, value) VALUES (?, ?)`,
        ["uiSettings", JSON.stringify(settings)],
      );
    } catch (err) {
      console.error("[uiStore] Failed to save UI settings:", err);
    }
  });

  async function loadSettingsFromDB() {
    if (!syncStore.isInitialized) return;
    try {
      const results = await syncStore.personalRepository().execute(
        `SELECT value FROM settings WHERE id = 'uiSettings'`,
      );
      // CORRECTED: Access the first element of the array directly
      const row = results[0];
      if (row && row.value) {
        const settings = JSON.parse(row.value);
        showDocuments.value = settings.showDocuments ?? true;
        showEditor.value = settings.showEditor ?? true;
        showPreview.value = settings.showPreview ?? true;
        showStats.value = settings.showStats ?? false;
        showMetadata.value = settings.showMetadata ?? false;
        editorMenuCollapsed.value = settings.editorMenuCollapsed ?? false;
        viewMenuCollapsed.value = settings.viewMenuCollapsed ?? false;
        toolsMenuCollapsed.value = settings.toolsMenuCollapsed ?? false;
        navbarCollapsed.value = settings.navbarCollapsed ?? false;
        scrollSync.value = settings.scrollSync ?? false;
      } else {
        resetToDefaults();
      }
    } catch (err) {
      console.error("[uiStore] Failed to load UI settings:", err);
      resetToDefaults();
    } finally {
      settingsLoaded = true;
    }
  }

  function resetToDefaults() {
    showDocuments.value = true;
    showEditor.value = true;
    showPreview.value = true;
    showStats.value = false;
    showMetadata.value = false;
    editorMenuCollapsed.value = false;
    viewMenuCollapsed.value = false;
    toolsMenuCollapsed.value = false;
    navbarCollapsed.value = false;
    scrollSync.value = false;
  }

  // Load settings when the DB is ready or when the user changes
  watch(
    () => [syncStore.isInitialized, authStore.user?.id],
    ([ready, _userId]) => {
      if (ready) {
        settingsLoaded = false; // Force reload on user change
        loadSettingsFromDB();
      }
    },
    { immediate: true },
  );

  // --- Computed Properties ---
  const isAnyMenuOpen = computed(
    () => showViewMenu.value || showActionBar.value || showFileMenu.value,
  );

  // --- Actions ---

  // Persisted Toggles
  const toggleAndSave = (prop) => {
    prop.value = !prop.value;
    saveSettingsToDB();
  };

  // Transient Menu Toggles
  const toggleMenu = (menuRef) => {
    const otherMenus = [showViewMenu, showActionBar, showFileMenu].filter(
      (m) => m !== menuRef,
    );
    const isOpening = !menuRef.value;

    // Close other menus
    otherMenus.forEach((m) => (m.value = false));

    // Toggle the target menu
    menuRef.value = isOpening;
  };

  // Toasts
  function addToast(message, type = "info", duration = 5000) {
    const id = Date.now() + Math.random();
    toasts.value.push({ id, message, type });
    setTimeout(() => removeToast(id), duration);
  }

  function removeToast(id) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  // Collapse Documents on mobile
  function collapseDocumentsOnMobile(isMobileView) {
    if (isMobileView && showDocuments.value) {
      showDocuments.value = false;
      saveSettingsToDB();
    }
  }

  return {
    // State
    showDocuments,
    showEditor,
    showPreview,
    showStats,
    showMetadata,
    editorMenuCollapsed,
    viewMenuCollapsed,
    toolsMenuCollapsed,
    navbarCollapsed,
    scrollSync,
    showViewMenu,
    showActionBar,
    showFileMenu,
    showImportModal,
    showExportModal,
    showGithubBackupModal,
    showVariablesModal,
    toasts,
    showImageLibraryModal,

    // Computed
    isAnyMenuOpen,

    // Actions
    loadSettingsFromDB,
    toggleDocuments: () => toggleAndSave(showDocuments),
    toggleEditor: () => toggleAndSave(showEditor),
    togglePreview: () => toggleAndSave(showPreview),
    toggleStats: () => toggleAndSave(showStats),
    toggleMetadata: () => toggleAndSave(showMetadata),
    toggleEditorMenuCollapsed: () => toggleAndSave(editorMenuCollapsed),
    toggleViewMenuCollapsed: () => toggleAndSave(viewMenuCollapsed),
    toggleToolsMenuCollapsed: () => toggleAndSave(toolsMenuCollapsed),
    toggleNavbarCollapsed: () => toggleAndSave(navbarCollapsed),
    toggleScrollSync: () => toggleAndSave(scrollSync),

    toggleViewMenu: () => toggleMenu(showViewMenu),
    toggleActionBar: () => toggleMenu(showActionBar),
    toggleFileMenu: () => toggleMenu(showFileMenu),

    closeAllMenus: () => {
      showViewMenu.value = false;
      showActionBar.value = false;
      showFileMenu.value = false;
    },

    openImportModal: () => (showImportModal.value = true),
    closeImportModal: () => (showImportModal.value = false),
    openExportModal: () => (showExportModal.value = true),
    closeExportModal: () => (showExportModal.value = false),
    openGithubBackupModal: () => (showGithubBackupModal.value = true),
    closeGithubBackupModal: () => (showGithubBackupModal.value = false),
    openVariablesModal: () => (showVariablesModal.value = true),
    closeVariablesModal: () => (showVariablesModal.value = false),
    openImageLibraryModal: () => (showImageLibraryModal.value = true),
    closeImageLibraryModal: () => (showImageLibraryModal.value = false),
    addToast,
    removeToast,
    collapseDocumentsOnMobile,
  };
});
