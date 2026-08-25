import { defineStore } from "pinia";
import { ref } from "vue";
import { useSyncStore } from "./syncStore";
import { useUiStore } from "./uiStore";
import { v4 as uuidv4 } from "uuid";

export const useTemplateStore = defineStore("templateStore", () => {
  const syncStore = useSyncStore();
  const uiStore = useUiStore();

  const templates = ref([]);
  const isLoading = ref(false);
  const error = ref("");
  const activeDbKey = ref(null);

  async function loadTemplates(dbKey) {
    if (!dbKey) throw new Error("Database scope is required to load templates.");
    isLoading.value = true;
    error.value = "";
    try {
      const rows = await syncStore.repository(dbKey).execute(
        "SELECT id, name, content, title_pattern, default_folder_id, created_at, updated_at FROM templates ORDER BY updated_at DESC",
      );
      templates.value = rows.map((r) => ({
        id: r.id,
        name: r.name,
        content: r.content,
        titlePattern: r.title_pattern || "",
        defaultFolderId: r.default_folder_id || null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      activeDbKey.value = dbKey;
    } catch (err) {
      error.value = err.message;
    } finally {
      isLoading.value = false;
    }
  }

  async function createTemplate(
    dbKey,
    name,
    content,
    titlePattern = "",
    defaultFolderId = null,
  ) {
    const id = uuidv4();
    const now = new Date().toISOString();
    try {
      await syncStore.repository(dbKey).transaction((repo) => repo.exec(
        "INSERT INTO templates (id, name, content, title_pattern, default_folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          name,
          content,
          titlePattern || "",
          defaultFolderId || null,
          now,
          now,
        ],
      ));
      await loadTemplates(dbKey);
      uiStore.addToast("Template created.", "success");
      return id;
    } catch (err) {
      uiStore.addToast("Failed to create template.", "error");
      throw err;
    }
  }

  async function updateTemplate(
    dbKey,
    id,
    name,
    content,
    titlePattern = "",
    defaultFolderId = null,
  ) {
    const now = new Date().toISOString();
    try {
      await syncStore.repository(dbKey).transaction((repo) => repo.exec(
        "UPDATE templates SET name = ?, content = ?, title_pattern = ?, default_folder_id = ?, updated_at = ? WHERE id = ?",
        [name, content, titlePattern || "", defaultFolderId || null, now, id],
      ));
      await loadTemplates(dbKey);
      uiStore.addToast("Template updated.", "success");
    } catch (err) {
      uiStore.addToast("Failed to update template.", "error");
      throw err;
    }
  }

  async function duplicateTemplate(dbKey, id) {
    const original = await syncStore.repository(dbKey).execute(
      "SELECT name, content, title_pattern, default_folder_id FROM templates WHERE id = ?",
      [id],
    );
    if (!original || original.length === 0)
      throw new Error("Template not found");

    const orig = original[0];
    const newId = uuidv4();
    const now = new Date().toISOString();
    const newName = `${orig.name} - Copy`;
    try {
      await syncStore.repository(dbKey).transaction((repo) => repo.exec(
        "INSERT INTO templates (id, name, content, title_pattern, default_folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          newId,
          newName,
          orig.content,
          orig.title_pattern || "",
          orig.default_folder_id || null,
          now,
          now,
        ],
      ));
      await loadTemplates(dbKey);
      uiStore.addToast("Template duplicated.", "success");
      return newId;
    } catch (err) {
      uiStore.addToast("Failed to duplicate template.", "error");
      throw err;
    }
  }

  async function deleteTemplate(dbKey, id) {
    try {
      await syncStore.repository(dbKey).transaction((repo) => repo.exec("DELETE FROM templates WHERE id = ?", [id]));
      await loadTemplates(dbKey);
      uiStore.addToast("Template deleted.", "success");
    } catch (err) {
      uiStore.addToast("Failed to delete template.", "error");
      throw err;
    }
  }

  return {
    templates,
    isLoading,
    error,
    activeDbKey,
    loadTemplates,
    createTemplate,
    updateTemplate,
    duplicateTemplate,
    deleteTemplate,
  };
});
