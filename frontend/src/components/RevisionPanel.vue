<template>
  <section
    :class="[
      'bg-white h-full flex flex-col',
      standalone ? 'w-full border border-gray-200 rounded-lg overflow-hidden' : 'w-[420px] border-l border-gray-200'
    ]"
    data-testid="revision-panel"
  >
    <div class="flex h-full min-h-0">
      <div class="w-[30rem] max-w-[30rem] shrink-0 border-r border-gray-200 min-h-0 flex flex-col overflow-y-auto">
        <div v-if="revisionStore.isListLoading && revisionStore.revisions.length === 0" class="p-3 space-y-2">
          <div v-for="idx in 6" :key="idx" class="h-10 animate-pulse rounded-md bg-gray-100"></div>
        </div>

        <div v-else-if="revisionStore.listError" class="p-3 text-sm text-red-600">
          <p>{{ revisionStore.listError }}</p>
          <button class="mt-2 text-xs text-blue-600 hover:underline" @click="refreshList">Retry</button>
        </div>

        <div v-else class="overflow-y-auto min-h-0">
          <button
            v-for="item in revisionStore.revisions"
            :key="item.id"
            class="w-full text-left px-3 py-2 border-b border-gray-100 hover:bg-gray-50"
            :class="item.id === revisionStore.selectedRevisionId ? 'bg-gray-100' : ''"
            @click="selectRevision(item.id)"
            :data-testid="`revision-item-${item.id}`"
          >
            <div class="text-xs text-gray-500">{{ formatTimestamp(item.createdAt) }}</div>
            <div class="text-sm font-medium text-gray-700 truncate">{{ item.title || '(Untitled)' }}</div>
            <div class="flex items-center gap-1 text-[11px] text-gray-400">
              <span class="uppercase tracking-wide">{{ item.type }}</span>
              <span v-if="item.actor" :data-testid="`revision-actor-${item.id}`">by {{ item.actor.name }}</span>
            </div>
          </button>

          <button
            v-if="revisionStore.hasMore"
            class="w-full px-3 py-2 text-xs text-blue-600 hover:bg-gray-50 border-t border-gray-100"
            @click="loadMore"
            :disabled="revisionStore.isListLoading"
          >
            {{ revisionStore.isListLoading ? 'Loading…' : 'Load older versions' }}
          </button>
        </div>
      </div>

      <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div v-if="revisionStore.isDetailLoading" class="p-3 space-y-2">
          <div class="h-5 animate-pulse rounded-md bg-gray-100"></div>
          <div class="h-40 animate-pulse rounded-md bg-gray-100"></div>
        </div>

        <div v-else-if="revisionStore.detailError" class="p-3 text-sm text-red-600">
          <p>{{ revisionStore.detailError }}</p>
          <button
            v-if="revisionStore.selectedRevisionId"
            class="mt-2 text-xs text-blue-600 hover:underline"
            @click="selectRevision(revisionStore.selectedRevisionId)"
          >
            Retry
          </button>
        </div>

        <template v-else-if="revisionStore.selectedRevisionDetail">
          <DiffView v-if="showCompare" :old-text="oldText" :new-text="newText" />

          <div v-else class="p-2 h-full">
            <textarea readonly class="pn-textarea h-full resize-none font-mono text-xs" :value="revisionStore.selectedRevisionDetail.content"></textarea>
          </div>
        </template>

        <div v-else class="p-3 text-sm text-gray-500">
          Select a revision to view details.
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import DiffView from '@/components/DiffView.vue';
import { useRevisionStore } from '@/store/revisionStore';
import { useDocStore } from '@/store/docStore';
import { useUiStore } from '@/store/uiStore';

defineProps({
  standalone: {
    type: Boolean,
    default: false,
  },
});

const revisionStore = useRevisionStore();
const docStore = useDocStore();
const ui = useUiStore();
const showCompare = ref(true);

const selectedFileId = computed(() => docStore.selectedFileId);
const selectedDbKey = computed(() => docStore.selectedDbKey);
const currentContent = computed(() => docStore.selectedFile?.content || '');
const oldText = computed(() => revisionStore.selectedRevisionDetail?.content || '');
const newText = computed(() => currentContent.value);

watch(
  () => [selectedFileId.value, selectedDbKey.value],
  async ([noteId, dbKey]) => {
    revisionStore.resetState();
    showCompare.value = true;
    if (!noteId || !dbKey) return;
    try {
      await revisionStore.fetchRevisions(dbKey, noteId, { reset: true, limit: 50 });
    } catch {
      // error is surfaced via store state and inline UI
    }
  },
  { immediate: true }
);

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

async function refreshList() {
  if (!selectedFileId.value) return;
  try {
    await revisionStore.fetchRevisions(selectedDbKey.value, selectedFileId.value, { reset: true, limit: 50 });
  } catch {
    // error is surfaced via store state and inline UI
  }
}

async function selectRevision(revisionId) {
  if (!selectedFileId.value || !revisionId) return;
  try {
    await revisionStore.fetchRevisionDetail(selectedDbKey.value, selectedFileId.value, revisionId);
  } catch {
    // error is surfaced via store state and inline UI
  }
}

async function loadMore() {
  if (!selectedFileId.value) return;
  try {
    await revisionStore.loadMore(selectedDbKey.value, selectedFileId.value, 50);
  } catch {
    // error is surfaced via store state and inline UI
  }
}

async function saveVersion() {
  if (!selectedFileId.value) return;
  try {
    const result = await revisionStore.saveManualRevision(selectedDbKey.value, selectedFileId.value);
    if (result?.created === false && result?.reason === 'duplicate-latest') {
      ui.addToast('Latest version is identical; nothing new was saved.', 'info');
      return;
    }
    ui.addToast('Version saved.', 'success');
  } catch (error) {
    ui.addToast(error?.message || 'Failed to save version.', 'error');
  }
}

async function restoreSelected() {
  if (!selectedFileId.value || !revisionStore.selectedRevisionId) return;

  try {
    const result = await revisionStore.restoreRevision(
      selectedDbKey.value,
      selectedFileId.value,
      revisionStore.selectedRevisionId
    );

    if (result?.note && docStore.selectedFile?.id === result.note.id) {
      docStore.selectedFile.title = result.note.title;
      docStore.selectedFile.content = result.note.content;
      docStore.selectedFile.updated_at = result.note.updatedAt;
    }

    await docStore.loadRootItems();
    ui.addToast('Revision restored.', 'success');
  } catch (error) {
    ui.addToast(error?.message || 'Failed to restore revision.', 'error');
  }
}

defineExpose({ showCompare, saveVersion, restoreSelected, revisionStore, selectedFileId });
</script>
