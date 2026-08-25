<template>
  <AccountLayout title="Templates">
    <!-- ===== List View ===== -->
    <div v-if="currentView === 'list'" class="space-y-6">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-sm text-gray-600">Templates: {{ templateStore.templates.length }}</p>
        <BaseButton
          variant="primary"
          size="md"
          @click="openCreate"
          data-testid="templates-new-button"
        >
          <Plus class="w-4 h-4" />
          <span>New</span>
        </BaseButton>
      </div>

      <div class="pn-table-wrap">
        <table class="pn-table">
          <thead>
            <tr>
              <th>Name</th>
              <th class="hidden sm:table-cell">Title Pattern</th>
              <th class="hidden md:table-cell">Folder</th>
              <th class="hidden lg:table-cell">Excerpt</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="templateStore.isLoading">
              <td colspan="6" class="pn-table-empty">Loading templates...</td>
            </tr>
            <tr v-else-if="templateStore.templates.length === 0">
              <td colspan="6" class="pn-table-empty">
                No templates yet. Create one to get started.
              </td>
            </tr>
            <tr
              v-else
              v-for="tpl in templateStore.templates"
              :key="tpl.id"
            >
              <td class="font-medium text-gray-900">{{ tpl.name }}</td>
              <td class="hidden text-gray-500 sm:table-cell">
                <span v-if="tpl.titlePattern" class="truncate block max-w-[180px]" :title="tpl.titlePattern">{{ tpl.titlePattern }}</span>
                <span v-else class="text-gray-400">—</span>
              </td>
              <td class="hidden text-gray-500 md:table-cell">
                <span v-if="tpl.defaultFolderId">{{ getFolderPath(tpl.defaultFolderId) || '—' }}</span>
                <span v-else class="text-gray-400">—</span>
              </td>
              <td class="hidden text-gray-500 lg:table-cell">{{ excerpt(tpl.content) }}</td>
              <td class="text-gray-500">{{ formatDate(tpl.updatedAt) }}</td>
              <td>
                <div class="flex items-center gap-1">
                  <BaseButton
                    @click="openEdit(tpl)"
                    :data-testid="`templates-edit-${tpl.id}`"
                  >
                    <Pencil class="w-4 h-4" />
                    <span>Edit</span>
                  </BaseButton>
                  <BaseButton
                    @click="handleDuplicate(tpl)"
                    :data-testid="`templates-duplicate-${tpl.id}`"
                  >
                    <Copy class="w-4 h-4" />
                    <span>Duplicate</span>
                  </BaseButton>
                  <BaseButton
                    variant="danger"
                    @click="handleDelete(tpl)"
                    :data-testid="`templates-delete-${tpl.id}`"
                  >
                    <Trash2 class="w-4 h-4" />
                    <span>Delete</span>
                  </BaseButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ===== Editor View ===== -->
    <div v-else class="space-y-6">
      <div class="flex items-center justify-between">
        <h2 class="pn-title-modal">
          {{ editingTemplate ? 'Edit Template' : 'New Template' }}
        </h2>
      </div>

      <div class="space-y-4">
        <div>
          <label class="pn-label" for="template-editor-name">Name</label>
          <input
            id="template-editor-name"
            v-model="form.name"
            type="text"
            maxlength="200"
            required
            placeholder="Template name"
            class="pn-input"
            data-testid="template-editor-name"
          />
        </div>

        <div>
          <label class="pn-label" for="template-editor-title-pattern">
            Title Pattern
            <span class="pn-label-optional">(optional)</span>
          </label>
          <input
            id="template-editor-title-pattern"
            v-model="form.titlePattern"
            type="text"
            maxlength="500"
            placeholder="Defaults to template name"
            class="pn-input"
            data-testid="template-editor-title-pattern"
          />
          <p class="pn-help">
            Available: <code class="text-gray-500">&#123;&#123;today&#125;&#125;</code>, <code class="text-gray-500">&#123;&#123;today:format&#125;&#125;</code>, <code class="text-gray-500">&#123;&#123;now&#125;&#125;</code>, <code class="text-gray-500">&#123;&#123;now:format&#125;&#125;</code>, <code class="text-gray-500">&#123;&#123;input:Label&#125;&#125;</code>
            &nbsp;·&nbsp; Format tokens: <code class="text-gray-500">dd</code> <code class="text-gray-500">MM</code> <code class="text-gray-500">yyyy</code> <code class="text-gray-500">yy</code> <code class="text-gray-500">HH</code> <code class="text-gray-500">mm</code> <code class="text-gray-500">ss</code>
          </p>
        </div>

        <div>
          <label class="pn-label" for="template-editor-default-folder">
            Default Folder
            <span class="pn-label-optional">(optional)</span>
          </label>
          <div class="flex items-center gap-2">
            <select
              id="template-editor-default-folder"
              v-model="form.defaultFolderId"
              class="pn-select"
              data-testid="template-editor-default-folder"
            >
              <option
                v-for="opt in folderOptions"
                :key="opt.id"
                :value="opt.id || ''"
              >{{ opt.name }}</option>
            </select>
            <BaseButton
              v-if="form.defaultFolderId"
              icon-only
              class="shrink-0 text-gray-400 hover:text-gray-600"
              title="Clear folder selection"
              aria-label="Clear folder selection"
              @click="form.defaultFolderId = ''"
            >
              <X class="w-4 h-4" />
            </BaseButton>
          </div>
        </div>

        <div>
          <label class="pn-label" for="template-editor-content">Content</label>
          <textarea
            id="template-editor-content"
            v-model="form.content"
            placeholder="Markdown content..."
            class="pn-textarea font-mono"
            style="min-height: 20rem;"
            data-testid="template-editor-content"
          ></textarea>
        </div>
      </div>

      <div class="flex items-center justify-end gap-3 border-t border-gray-200 pt-5">
        <BaseButton
          variant="secondary"
          size="md"
          @click="handleCancel"
          data-testid="template-editor-cancel"
        >
          <span>Cancel</span>
        </BaseButton>
        <BaseButton
          variant="primary"
          size="md"
          @click="handleSave"
          data-testid="template-editor-save"
        >
          <span>Save</span>
        </BaseButton>
      </div>
    </div>
  </AccountLayout>
</template>

<script setup>
import { onMounted, reactive, ref, watch } from 'vue';
import { Pencil, Copy, Trash2, Plus, X } from 'lucide-vue-next';
import AccountLayout from '@/components/AccountLayout.vue';
import BaseButton from '@/components/BaseButton.vue';
import { useTemplateStore } from '@/store/templateStore';
import { useSyncStore } from '@/store/syncStore';
import { useStructureStore } from '@/store/structureStore';
import { useUiStore } from '@/store/uiStore';

const templateStore = useTemplateStore();
const syncStore = useSyncStore();
const structureStore = useStructureStore();
const uiStore = useUiStore();

const currentView = ref('list');
const editingTemplate = ref(null);

const form = reactive({
  name: '',
  titlePattern: '',
  defaultFolderId: '',
  content: '',
});

// Pre-built flat folder list and id→path map, populated asynchronously
const folderOptions = ref([{ id: '', name: '— Use current folder —' }]);
const folderPathMap = ref(new Map());

async function buildFolderTree() {
  const options = [{ id: '', name: '— Use current folder —' }];
  const pathMap = new Map();

  async function walk(items, depth = 0, ancestors = []) {
    for (const item of items) {
      if (item.type === 'folder') {
        const prefix = '\u00A0\u00A0'.repeat(depth);
        options.push({ id: item.id, name: prefix + item.name });
        const currentPath = [...ancestors, item.name];
        pathMap.set(item.id, currentPath.join(' / '));
        const children = await structureStore.getChildren(item.id);
        await walk(children, depth + 1, currentPath);
      }
    }
  }

  await walk(structureStore.rootItems);
  folderOptions.value = options;
  folderPathMap.value = pathMap;
}

// Resolve a folder ID to a display path for the list view
function getFolderPath(folderId) {
  if (!folderId) return null;
  return folderPathMap.value.get(folderId) || null;
}

// Build the tree whenever rootItems change
watch(
  () => structureStore.rootItems,
  () => { buildFolderTree(); },
  { immediate: true },
);

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function excerpt(content) {
  if (!content) return '';
  const firstLine = content.split('\n')[0];
  return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;
}

function openCreate() {
  editingTemplate.value = null;
  form.name = '';
  form.titlePattern = '';
  form.defaultFolderId = '';
  form.content = '';
  currentView.value = 'editor';
}

function openEdit(tpl) {
  editingTemplate.value = tpl;
  form.name = tpl.name;
  form.titlePattern = tpl.titlePattern || '';
  form.defaultFolderId = tpl.defaultFolderId || '';
  form.content = tpl.content;
  currentView.value = 'editor';
}

function hasUnsavedChanges() {
  if (!editingTemplate.value) {
    return form.name.trim() !== '' || form.titlePattern !== '' || form.defaultFolderId !== '' || form.content !== '';
  }
  return (
    form.name !== editingTemplate.value.name ||
    form.titlePattern !== (editingTemplate.value.titlePattern || '') ||
    form.defaultFolderId !== (editingTemplate.value.defaultFolderId || '') ||
    form.content !== editingTemplate.value.content
  );
}

function handleCancel() {
  if (hasUnsavedChanges()) {
    const confirmed = window.confirm('You have unsaved changes. Discard them?');
    if (!confirmed) return;
  }
  currentView.value = 'list';
  editingTemplate.value = null;
}

async function handleSave() {
  if (!form.name.trim()) {
    uiStore.addToast('Template name is required.', 'error');
    return;
  }
  try {
    const folderId = form.defaultFolderId || null;
    if (editingTemplate.value) {
      await templateStore.updateTemplate(
        syncStore.personalDbKey,
        editingTemplate.value.id,
        form.name.trim(),
        form.content,
        form.titlePattern.trim(),
        folderId,
      );
    } else {
      await templateStore.createTemplate(
        syncStore.personalDbKey,
        form.name.trim(),
        form.content,
        form.titlePattern.trim(),
        folderId,
      );
    }
    currentView.value = 'list';
    editingTemplate.value = null;
  } catch (err) {
    // Toast already shown in store
  }
}

async function handleDuplicate(tpl) {
  try {
    await templateStore.duplicateTemplate(syncStore.personalDbKey, tpl.id);
  } catch (err) {
    // Toast already shown in store
  }
}

async function handleDelete(tpl) {
  const confirmed = window.confirm(`Delete template "${tpl.name}"?`);
  if (!confirmed) return;
  try {
    await templateStore.deleteTemplate(syncStore.personalDbKey, tpl.id);
  } catch (err) {
    // Toast already shown in store
  }
}

onMounted(() => {
  templateStore.loadTemplates(syncStore.personalDbKey);
});
</script>
