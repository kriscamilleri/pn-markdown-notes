<template>
  <div
    v-if="file"
    class="h-full flex flex-col gap-0"
  >
    <div
      v-if="ui.showMetadata"
      class="p-2 bg-gray-50 text-gray-700 text-sm border-b border-gray-200"
      data-testid="editor-metadata-container"
    >
      <div class="flex min-w-0 flex-wrap gap-x-4 gap-y-1">
        <div class="flex items-center gap-2">
          <span class="font-medium">Name:</span>
          <span data-testid="editor-metadata-name">{{ file.title || file.name }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="font-medium">Type:</span>
          <span data-testid="editor-metadata-type">Document</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="font-medium">Visibility:</span>
          <span data-testid="editor-metadata-visibility">{{ file.visibility || 'Private' }}</span>
        </div>
        <div v-if="file.spaceName" class="flex items-center gap-2">
          <span class="font-medium">Space:</span>
          <span data-testid="editor-metadata-space">{{ file.spaceName }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="font-medium">Last Updated:</span>
          <span data-testid="editor-metadata-updated">{{ new Date(file.updated_at).toLocaleString() }}</span>
        </div>
      </div>
    </div>

    <div
      v-if="isUploading"
      class="mb-4 p-2 bg-blue-50 text-blue-700 rounded flex items-center"
      data-testid="editor-upload-progress"
    >
      <span class="mr-2">Uploading image...</span>
      <div class="animate-spin h-4 w-4 border-2 border-blue-500 rounded-full border-t-transparent"></div>
    </div>

    <div
      v-if="uploadError"
      class="mb-4 p-2 bg-red-50 text-red-700 rounded"
      data-testid="editor-upload-error"
    >
      {{ uploadError }}
    </div>

    <div
      v-if="isSharedDocument"
      class="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2"
      data-testid="collab-status"
    >
      <template v-if="!collabActive">
        <span class="pn-meta">Solo editing</span>
        <BaseButton
          size="sm"
          variant="secondary"
          :disabled="!syncOnline"
          data-testid="collab-start"
          @click="startCollaboration"
        >Collaborate</BaseButton>
      </template>
      <template v-else>
        <span
          class="pn-meta"
          :class="{ 'text-amber-600': collabStatus === 'reconnecting', 'text-red-600': collabStatus === 'dropped' }"
        >{{ collabStatusLabel }}</span>
        <AvatarStack
          v-if="collabParticipants.length"
          :users="collabParticipants"
          size="sm"
          data-testid="collab-participants"
        />
        <span class="pn-meta">{{ collabUnacked }} unsaved {{ collabUnacked === 1 ? 'change' : 'changes' }}</span>
        <div class="ml-auto flex items-center gap-2">
          <BaseButton
            size="sm"
            :disabled="collabStatus !== 'live' || collabUnacked > 0"
            data-testid="collab-commit"
            @click="showCollabSave = true"
          >Save version</BaseButton>
          <BaseButton size="sm" variant="ghost" data-testid="collab-leave" @click="leaveCollaboration">Leave</BaseButton>
        </div>
      </template>
    </div>

    <div
      v-if="collabLastError"
      class="pn-alert pn-alert-warning rounded-none"
      :data-testid="collabStatus === 'dropped' ? 'collab-readonly-notice' : 'collab-error'"
    >{{ collabLastError }}</div>

    <BaseModal
      :show="showCollabSave"
      title="Save document version"
      :close-on-backdrop="false"
      @close="showCollabSave = false"
    >
      <p>This saves the session's agreed text as a normal document version for everyone in this space.</p>
      <template #footer>
        <BaseButton variant="secondary" @click="showCollabSave = false">Cancel</BaseButton>
        <BaseButton data-testid="collab-commit-confirm" @click="confirmCollabSave">Save version</BaseButton>
      </template>
    </BaseModal>

    <div
      v-if="ui.showStats"
      class="p-2 bg-gray-50 text-gray-700 text-sm flex gap-4 border-b border-gray-200"
      data-testid="editor-stats-display"
    >
      <div class="flex items-center gap-1">
        <span class="font-medium">Words:</span>
        <span data-testid="editor-stats-words">{{ wordCount }}</span>
      </div>
      <div class="flex items-center gap-1">
        <span class="font-medium">Characters:</span>
        <span data-testid="editor-stats-chars">{{ characterCount }}</span>
      </div>
      <div class="flex items-center gap-1">
        <span class="font-medium">Lines:</span>
        <span data-testid="editor-stats-lines">{{ lineCount }}</span>
      </div>
      <div class="flex items-center gap-1 ml-auto">
        <span
          data-testid="editor-save-status"
          class="pn-meta"
          :class="{ 'text-amber-600': isDirty }"
        >{{ saveStatusLabel }}</span>
      </div>
    </div>

    <div
      v-if="persistedConflict || conflict"
      class="pn-alert pn-alert-warning mt-0 rounded-none"
      data-testid="editor-conflict-banner"
    >
      <div class="flex-1">
        <template v-if="persistedConflict">
          <p class="font-medium">Some document changes need your review.</p>
          <p class="text-sm">{{ persistedConflictSummary }}</p>
        </template>
        <template v-else>
          <p class="font-medium">This document was updated elsewhere.</p>
          <p class="text-sm">Your unsaved changes are being held.</p>
        </template>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <BaseButton
          v-if="persistedConflict"
          size="sm"
          variant="secondary"
          data-testid="editor-conflict-resolve"
          @click="showResolution = true"
        >Resolve</BaseButton>
        <template v-else>
          <BaseButton
            size="sm"
            variant="secondary"
            data-testid="editor-conflict-keep-mine"
            @click="keepMine"
          >Keep mine</BaseButton>
          <BaseButton
            size="sm"
            variant="secondary"
            data-testid="editor-conflict-use-theirs"
            @click="useTheirs"
          >Use theirs</BaseButton>
          <BaseButton
            size="sm"
            variant="ghost"
            data-testid="editor-conflict-compare"
            @click="openCompare"
          >Compare</BaseButton>
        </template>
      </div>
    </div>

    <BaseModal
      :show="showCompare"
      title="Compare versions"
      size="lg"
      :close-on-backdrop="false"
      close-testid="editor-conflict-compare-close"
      @close="showCompare = false"
    >
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 h-[60vh]">
        <div class="min-h-0 flex flex-col">
          <h4 class="pn-title-sub mb-2">Remote changes</h4>
          <DiffView :old-text="compareBase" :new-text="compareTheirs" />
        </div>
        <div class="min-h-0 flex flex-col">
          <h4 class="pn-title-sub mb-2">Your changes</h4>
          <DiffView :old-text="compareBase" :new-text="compareMine" />
        </div>
      </div>
      <template #footer>
        <BaseButton
          size="md"
          variant="secondary"
          @click="showCompare = false"
        >Close</BaseButton>
      </template>
    </BaseModal>

    <ConflictResolutionModal
      v-if="persistedConflict"
      :show="showResolution"
      :conflict="persistedConflict"
      :applying="isApplyingResolution"
      @close="showResolution = false"
      @apply="applyPersistedResolution"
    />

    <ConflictResolutionModal
      v-if="collabConflict"
      :show="showCollabConflict"
      :conflict="collabConflict"
      @close="showCollabConflict = false"
      @apply="applyCollabResolution"
    />

    <div class="flex-1 flex flex-col min-h-0 mt-0">
      <div
        ref="editorContainerRef"
        class="flex-1 bg-white mt-0 p-0"
        :class="{ 'opacity-50 cursor-not-allowed': collabStatus === 'dropped' }"
        data-testid="editor-container"
      ></div>
    </div>
  </div>

  <div
    v-else
    data-testid="editor-no-file"
  >
    <p class="text-gray-500 mt-3 ml-3">No Document selected</p>
  </div>
</template>

<style scoped>
/* Remove all padding and margin from editor container */
[data-testid="editor-container"] {
  padding: 0 !important;
  margin: 0 !important;
}

:deep(.overtype-container),
:deep(.overtype-wrapper),
:deep(.overtype-editor),
:deep(.overtype-preview),
:deep(textarea) {
  background-color: white !important;
}

:deep(.overtype-container) {
  padding-top: 0 !important;
  margin-top: 0 !important;
}

:deep(.overtype-wrapper) {
  padding-top: 0 !important;
  margin-top: 0 !important;
}

:deep(.overtype-editor) {
  padding-top: 0 !important;
  margin-top: 0 !important;
}

:deep(.code-block-line) {
  background-color: #f3f4f6 !important;
}
</style>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useDocStore } from '@/store/docStore';
import { useUiStore } from '@/store/uiStore';
import { useDraftStore } from '@/store/draftStore';
import { useAuthStore } from '@/store/authStore';
import { useEditorStore } from '@/store/editorStore';
import { useHistoryStore } from '@/store/historyStore';
import { useThemeStore } from '@/store/themeStore';
import { useConflictStore } from '@/store/conflictStore';
import { useSyncStore } from '@/store/syncStore';
import { useCollabSessionStore } from '@/store/collabSessionStore';
import { useOverTypePatches } from '@/composables/useOverTypePatches';
import { hasDocumentContentChanged, classifyEditorConflict } from '@/utils/documentPersistence';
import BaseButton from '@/components/BaseButton.vue';
import BaseModal from '@/components/BaseModal.vue';
import DiffView from '@/components/DiffView.vue';
import ConflictResolutionModal from '@/components/ConflictResolutionModal.vue';
import AvatarStack from '@/components/AvatarStack.vue';
import { YTextareaBinding } from '@/utils/yTextareaBinding';
import { buildConflictResolutionPlan } from '@panino/content-merge';
import OverType from 'overtype';

useOverTypePatches();

/* ───── helpers ───── */
function debounce(fn, wait) {
  let timeout;
  function debounced(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  }

  debounced.cancel = () => clearTimeout(timeout);
  return debounced;
}

const isProduction = import.meta.env.PROD;
const devImageServiceUrl = import.meta.env.VITE_API_SERVICE_URL || 'http://localhost:3001';
const imageServiceUrl = isProduction ? '/api' : devImageServiceUrl;

/* ───── stores & refs ───── */
const docStore = useDocStore();
const ui = useUiStore();
const draftStore = useDraftStore();
const authStore = useAuthStore();
const editorStore = useEditorStore();
const historyStore = useHistoryStore(); // <--- INIT STORE
const themeStore = useThemeStore();
const conflictStore = useConflictStore();
const syncStore = useSyncStore();
const collabStore = useCollabSessionStore();
const editorContainerRef = ref(null);
const editorInstance = ref(null);

const { selectedFile: file, isSaving, isDirty } = storeToRefs(docStore);
const {
  status: collabStatus,
  participants: collabParticipants,
  lastError: collabLastError,
  ydoc: collabYdoc,
  isActive: collabActive,
  unackedCount: collabUnacked,
  conflict: collabConflict,
} = storeToRefs(collabStore);
const collabBinding = ref(null);
const showCollabSave = ref(false);
const showCollabConflict = ref(false);
const syncOnline = computed(() => syncStore.isOnline);
const isSharedDocument = computed(() => file.value?.dbKey?.startsWith('space:'));
const collabStatusLabel = computed(() => ({
  opening: 'Joining live session…',
  live: 'Live session',
  reconnecting: 'Reconnecting…',
  committing: 'Saving version…',
  dropped: 'Live session disconnected',
}[collabStatus.value] || 'Solo editing'));

/* ───── upload state ───── */
const isUploading = ref(false);
const uploadError = ref('');

/* ───── reactive draft ───── */
const contentDraft = ref('');

/* ───── editor conflict safety (COLLAB-01) ───── */
// Non-null while the open document has diverged from a remote edit:
// `{ theirs: string }` holds the remote body we have not adopted.
const conflict = ref(null);
const showCompare = ref(false);
const persistedConflict = ref(null);
const showResolution = ref(false);
const isApplyingResolution = ref(false);
// Set while the editor value is being changed programmatically (adoption or
// resolution), so the resulting onChange does not schedule a DB write or
// re-enter classification.
const isProgrammaticUpdate = ref(false);

/* ───── debounced save ───── */
const debouncedSyncToDB = debounce((id, text) => {
  docStore.updateFileContent(id, text, file.value?.dbKey);
}, 500);

/* ───── History Setup ───── */
const isHistoryAction = ref(false)
// Create a debounced record function for typing
const debouncedRecord = debounce((text, cursor) => {
  if (file.value) {
    historyStore.record(file.value.id, text, cursor);
  }
}, 500);

/* ───── Keydown Handler (Trap Undo/Redo) ───── */
function handleKeydown(e) {
  // Trap Ctrl+Z (Undo)
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    performUndo();
    return;
  }

  // Trap Ctrl+Y or Ctrl+Shift+Z (Redo)
  if (
    (e.ctrlKey || e.metaKey) &&
    (e.key === 'y' || (e.shiftKey && e.key === 'z'))
  ) {
    e.preventDefault();
    performRedo();
    return;
  }
}

/* ───── Handle Native Input ───── */
// This runs on every keystroke via the native event listener
// This runs on every keystroke via the native event listener
function handleNativeInput(e) {
  if (isHistoryAction.value || !file.value || collabActive.value) return;

  const textarea = e.target;
  const val = textarea.value;
  const cursor = textarea.selectionEnd;

  // Handle input types that should trigger immediate saves
  const inputType = e.inputType;
  const char = e.data;

  // Added insertLineBreak here 👇
  const isDelimiter =
    inputType === 'insertParagraph' ||
    inputType === 'insertLineBreak' ||
    (char && /[\s.,;!?:(){}[\]"']/.test(char));

  if (isDelimiter) {
    // Record immediately on word break/sentence end
    historyStore.record(file.value.id, val, cursor);
  } else {
    // Debounce for character streams
    debouncedRecord(val, cursor);
  }
}

/* ───── History Methods ───── */
function performUndo() {
  if (!file.value) return;
  if (collabBinding.value && collabActive.value) {
    collabBinding.value.undo();
    return;
  }
  const previousState = historyStore.undo(file.value.id);
  if (previousState) applyHistoryState(previousState);
}

function performRedo() {
  if (!file.value) return;
  if (collabBinding.value && collabActive.value) {
    collabBinding.value.redo();
    return;
  }
  const nextState = historyStore.redo(file.value.id);
  if (nextState) applyHistoryState(nextState);
}

function applyHistoryState(state) {
  // Lock: prevent handleInput from recording this change as a new user action
  isHistoryAction.value = true;

  if (editorInstance.value && state) {
    const textarea = getTextareaElement();

    // 1. Update OverType (Visuals)
    // using setValue is safer than setting textarea.value manually for OverType sync
    editorInstance.value.setValue(state.text);

    // 2. Update Internal Draft State
    contentDraft.value = state.text;
    if (file.value) {
      draftStore.setDraft(file.value.id, state.text);
      debouncedSyncToDB(file.value.id, state.text);
    }

    // 3. Restore Cursor
    nextTick(() => {
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(state.cursor, state.cursor);
      }
      // Unlock after DOM updates
      setTimeout(() => { isHistoryAction.value = false; }, 50);
    });
  } else {
    isHistoryAction.value = false;
  }
}

/* ───── Format Wrapping ───── */
// Pass the current cursor position
function wrapWithRecord(fn) {
  return (...args) => {
    if (!file.value) return;

    if (collabActive.value) {
      fn(...args);
      return;
    }

    const textarea = getTextareaElement();
    const cursor = textarea ? textarea.selectionEnd : 0;

    // 1. Snapshot BEFORE formatting
    historyStore.record(file.value.id, contentDraft.value, cursor);

    // 2. Perform formatting
    fn(...args);

    // Snapshot AFTER formatting
    nextTick(() => {
      const newCursor = textarea ? textarea.selectionEnd : 0;
      historyStore.record(file.value.id, contentDraft.value, newCursor);
    });
  }
}

function handleInput(value) {
  contentDraft.value = value;

  if (file.value) {
    draftStore.setDraft(file.value.id, value);

    // A live session owns persistence. The textarea binding emits a compact
    // Yjs edit; ordinary local database saving and COLLAB-01/02 are paused.
    if (collabActive.value) {
      debouncedSyncToDB.cancel();
      const textarea = getTextareaElement();
      collabStore.sendAwareness({
        cursor: textarea?.selectionStart,
        selection: textarea?.selectionEnd,
        idle: false,
      });
      return;
    }

    // A programmatic setValue (adoption/resolution) refreshes bookkeeping but
    // must not schedule a database write.
    if (isProgrammaticUpdate.value) return;

    // While diverged, local writes are held and never reach the database.
    if (conflict.value || persistedConflict.value) {
      debouncedSyncToDB.cancel();
      return;
    }

    if (hasDocumentContentChanged(file.value.content, value)) {
      debouncedSyncToDB(file.value.id, value);
    } else {
      debouncedSyncToDB.cancel();
    }
  }
}

/* ───── Overtype initialization ───── */
function initEditor() {
  if (!editorContainerRef.value || editorInstance.value) return;

  const [editor] = OverType.init(editorContainerRef.value, {
    theme: getEditorTheme(themeStore.theme),
    toolbar: false,  // Disable Overtype's toolbar - we use our own SubMenuBar
    showStats: false,  // Disable OverType's built-in stats - we use our own external display
    placeholder: 'Start writing...',
    value: contentDraft.value || '',
    onChange: (value) => {
      handleInput(value);
    },
    onKeydown: (event) => {
      // Forward keydown to our handler
      handleKeydown(event);

      // Handle paste event for images
      if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
        // Paste will be handled by the native paste event
      }

    },
    autoResize: true,
    minHeight: '200px'
  });

  editorInstance.value = editor;

  // Add paste event listener to the textarea
  nextTick(() => {
    const textarea = getTextareaElement();
    if (textarea) {
      textarea.addEventListener('paste', handlePaste);
      textarea.addEventListener('input', handleNativeInput);
      // Keydown is handled by OverType config, or add manually if OverType consumes it:
      // textarea.addEventListener('keydown', handleKeydown);
    }
  });
}

function getEditorTheme(theme) {
  if (theme === 'dark') {
    return {
      name: 'panino-navy-dark',
      colors: {
        bgPrimary: '#2c2c2c',
        bgSecondary: '#151515',
        text: '#d4d4d4',
        h1: '#d4d4d4',
        h2: '#c6c6c6',
        h3: '#c6c6c6',
        strong: '#d4d4d4',
        em: '#d4d4d4',
        link: '#87d1ff',
        code: '#d4d4d4',
        codeBg: '#242424',
        blockquote: '#a6a6a6',
        hr: '#343434',
        syntaxMarker: 'rgba(166, 166, 166, 0.7)',
        cursor: '#77a0a5',
        selection: 'rgba(147, 119, 165, 0.5)'
      }
    };
  }

  return {
    name: 'panino-theme',
    colors: {
      bgPrimary: '#ffffff',
      bgSecondary: '#ffffff',
      text: '#111827',
      h1: '#111827',
      h2: '#1f2937',
      h3: '#1f2937',
      strong: '#111827',
      em: '#111827',
      link: '#1d4ed8',
      code: '#111827',
      codeBg: '#f3f4f6',
      blockquote: '#4b5563',
      hr: '#d1d5db',
      syntaxMarker: 'rgba(75, 85, 99, 0.5)',
      cursor: '#2563eb',
      selection: 'rgba(37, 99, 235, 0.15)'
    }
  };
}

function destroyEditor() {
  collabBinding.value?.destroy();
  collabBinding.value = null;
  // Remove paste event listener
  const textarea = getTextareaElement();
  if (textarea) {
    textarea.removeEventListener('paste', handlePaste);
    textarea.removeEventListener('input', handleNativeInput);
  }

  if (editorInstance.value) {
    editorInstance.value.destroy();
    editorInstance.value = null;
  }
}

/* ───── watch for file presence (DOM mount/unmount) ───── */
watch(() => file.value, (newFile) => {
  if (newFile && !editorInstance.value) {
    // File selected but no editor - initialize on next tick
    nextTick(() => {
      if (!editorInstance.value && editorContainerRef.value) {
        initEditor();
      }
    });
  } else if (!newFile && editorInstance.value) {
    // No file selected - destroy editor
    destroyEditor();
  }
});

/* ───── watch for file changes (id + content, ordered) ───── */
function setEditorValue(text, { preserveCursor = true } = {}) {
  const textarea = getTextareaElement();
  const selStart = textarea ? textarea.selectionStart : 0;
  const selEnd = textarea ? textarea.selectionEnd : 0;

  isProgrammaticUpdate.value = true;
  try {
    if (editorInstance.value) {
      editorInstance.value.setValue(text);
    } else {
      contentDraft.value = text;
      return;
    }
  } finally {
    // Clear the guard after OverType's onChange has had a chance to run. It may
    // fire synchronously or on the next tick; the timeout covers both.
    nextTick(() => { isProgrammaticUpdate.value = false; });
    setTimeout(() => { isProgrammaticUpdate.value = false; }, 0);
  }

  if (preserveCursor) {
    const length = text.length;
    const start = Math.min(selStart, length);
    const end = Math.min(selEnd, length);
    nextTick(() => {
      const ta = getTextareaElement();
      if (ta) {
        ta.focus();
        ta.setSelectionRange(start, end);
      }
    });
  }
}

function clearConflict() {
  conflict.value = null;
  showCompare.value = false;
}

function adoptRemote(fileId, theirs) {
  const normalized = theirs ?? '';
  contentDraft.value = normalized;
  draftStore.setDraft(fileId, normalized);
  draftStore.setBase(fileId, normalized);
  setEditorValue(normalized, { preserveCursor: true });
}

function enterConflict(fileId, theirs) {
  conflict.value = { theirs: theirs ?? '' };
  // Hold local writes; the actual fix is that nothing reaches the database
  // until the user resolves.
  debouncedSyncToDB.cancel();
}

async function keepMine() {
  const id = file.value?.id;
  if (!id) return;
  const mine = contentDraft.value;
  draftStore.setBase(id, mine);
  draftStore.setDraft(id, mine);
  clearConflict();
  await docStore.updateFileContent(id, mine, file.value.dbKey);
}

async function useTheirs() {
  const id = file.value?.id;
  if (!id) return;
  const theirs = conflict.value?.theirs ?? '';
  draftStore.setBase(id, theirs);
  draftStore.setDraft(id, theirs);
  clearConflict();
  setEditorValue(theirs, { preserveCursor: true });
}

function openCompare() {
  showCompare.value = true;
}

function classifyRemoteContent(fileId, theirs) {
  if (collabActive.value && collabStore.noteId === fileId) return;
  const mine = contentDraft.value;
  const base = draftStore.getBase(fileId) ?? '';
  const action = classifyEditorConflict({ mine, base, theirs });

  if (action === 'adopt') {
    adoptRemote(fileId, theirs);
  } else if (action === 'conflict') {
    enterConflict(fileId, theirs);
  }
}

function handleDocumentSwitch(newId) {
  if (collabActive.value && collabStore.noteId !== newId) collabStore.leave();
  clearConflict();
  persistedConflict.value = null;
  showResolution.value = false;
  debouncedSyncToDB.cancel();
  debouncedRecord.cancel();

  if (newId) {
    const newContent = file.value?.content ?? '';

    // Initialize history for this file (keeps existing stack if revisited)
    historyStore.initialize(newId, newContent);

    contentDraft.value = newContent;
    draftStore.setDraft(newId, newContent);
    draftStore.setBase(newId, newContent);

    // If editor exists, update its value
    if (editorInstance.value) {
      setEditorValue(newContent, { preserveCursor: false });
    } else {
      // If no editor, initialize it (will happen on next tick after DOM updates)
      nextTick(() => {
        initEditor();
      });
    }
  } else {
    contentDraft.value = '';
    if (editorInstance.value) {
      setEditorValue('', { preserveCursor: false });
    }
  }
}

watch(
  () => [file.value?.id, conflictStore.conflictedNoteIds],
  async ([noteId]) => {
    if (!noteId || !conflictStore.hasConflict(noteId, file.value?.dbKey)) {
      persistedConflict.value = null;
      showResolution.value = false;
      return;
    }
    const loaded = await conflictStore.loadConflict(noteId, file.value?.dbKey);
    if (file.value?.id === noteId) persistedConflict.value = loaded;
  },
  { immediate: true },
);

function bindLiveEditor() {
  collabBinding.value?.destroy();
  collabBinding.value = null;
  const textarea = getTextareaElement();
  const ytext = collabYdoc.value?.getText('content');
  if (!textarea || !ytext || !collabActive.value) return;
  collabBinding.value = new YTextareaBinding({
    textarea,
    ytext,
    origin: collabStore.localOrigin,
    applyValue: (value) => setEditorValue(value, { preserveCursor: false }),
  });
  const value = ytext.toString();
  contentDraft.value = value;
  setEditorValue(value, { preserveCursor: true });
}

async function startCollaboration() {
  if (!isSharedDocument.value || !file.value?.id) return;
  debouncedSyncToDB.cancel();
  if (isDirty.value) await docStore.updateFileContent(file.value.id, contentDraft.value, file.value.dbKey);
  // Admission reads the durable server Document as the Yjs base. Flush any
  // local solo edit/creation first so starting collaboration cannot silently
  // reopen an older body or fail because the new Document is not uploaded yet.
  await syncStore.sync(file.value.dbKey);
  collabStore.open(file.value.dbKey.slice('space:'.length), file.value.id);
}

function confirmCollabSave() {
  if (collabStore.saveVersion()) showCollabSave.value = false;
}

function leaveCollaboration() {
  collabBinding.value?.destroy();
  collabBinding.value = null;
  collabStore.leave();
  showCollabSave.value = false;
}

function applyCollabResolution(content) {
  if (collabStore.resolveConflict(content)) {
    showCollabConflict.value = false;
    ui.addToast('Conflict choices applied to the live session. Save the version when ready.', 'success');
  }
}

watch(collabYdoc, () => nextTick(bindLiveEditor));

watch(collabStatus, (status) => {
  const textarea = getTextareaElement();
  if (textarea) textarea.disabled = status === 'dropped';
  if (status === 'idle') {
    collabBinding.value?.destroy();
    collabBinding.value = null;
  } else if (status === 'live' && !collabBinding.value) {
    nextTick(bindLiveEditor);
  }
});

watch(collabConflict, (value) => {
  showCollabConflict.value = Boolean(value);
});

watch(
  () => [file.value?.id, file.value?.content],
  ([newId, newContent], oldValue) => {
    const oldId = oldValue ? oldValue[0] : undefined;
    if (newId !== oldId) {
      handleDocumentSwitch(newId);
      return;
    }
    if (newId) {
      classifyRemoteContent(newId, newContent ?? '');
    }
  },
  { immediate: true },
);

watch(() => themeStore.theme, () => {
  if (!editorInstance.value) return;
  destroyEditor();
  nextTick(initEditor);
});

/* ───── stats ───── */
const wordCount = computed(() => (contentDraft.value ? contentDraft.value.trim().split(/\s+/).filter(Boolean).length : 0));
const characterCount = computed(() => contentDraft.value.length);
const lineCount = computed(() => (contentDraft.value ? contentDraft.value.split('\n').length : 0));

/* ───── persistence indicator (COLLAB-01) ───── */
const saveStatusLabel = computed(() => {
  if (isSaving.value) return 'Saving…';
  if (isDirty.value) return 'Unsaved changes';
  return 'Saved';
});

/* ───── conflict compare (COLLAB-01) ───── */
const compareBase = computed(() => (file.value ? draftStore.getBase(file.value.id) ?? '' : ''));
const compareTheirs = computed(() => conflict.value?.theirs ?? '');
const compareMine = computed(() => contentDraft.value);
const persistedConflictSummary = computed(() => {
  if (!persistedConflict.value) return '';
  const plan = buildConflictResolutionPlan({
    base: persistedConflict.value.baseContent,
    mine: persistedConflict.value.mineContent,
    theirs: persistedConflict.value.theirsContent,
  });
  if (plan.status === 'conflict') {
    const count = plan.regions.filter((region) => region.type === 'conflict').length;
    return `Some changes merged automatically. ${count} ${count === 1 ? 'region needs' : 'regions need'} a decision.`;
  }
  if (plan.status === 'clean') return 'The changes can be combined automatically. Review the result before applying it.';
  return 'This document is too large for per-region comparison. Choose the complete version to keep.';
});

async function applyPersistedResolution(content) {
  const activeConflict = persistedConflict.value;
  const id = file.value?.id;
  if (!activeConflict || !id || activeConflict.noteId !== id) return;

  isApplyingResolution.value = true;
  debouncedSyncToDB.cancel();
  try {
    await conflictStore.resolveConflict(activeConflict, content);
    contentDraft.value = content;
    draftStore.setDraft(id, content);
    draftStore.setBase(id, content);
    file.value.content = content;
    setEditorValue(content, { preserveCursor: true });
    docStore.structureStore.markContentChanged();
    persistedConflict.value = null;
    showResolution.value = false;
    ui.addToast('Document changes resolved.', 'success');
  } catch (error) {
    if (error?.code === 'CONFLICT_STALE') {
      persistedConflict.value = await conflictStore.loadConflict(id, file.value?.dbKey);
    }
    ui.addToast(error?.message || 'Could not apply the document resolution.', 'error');
  } finally {
    isApplyingResolution.value = false;
  }
}

/* ───── paste-images & upload helper ───── */
async function handlePaste(event) {
  const items = event.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      event.preventDefault();
      const fileObj = item.getAsFile();
      if (fileObj) await uploadImage(fileObj, { isClipboard: true });
      break;
    }
  }
}

function getScreenshotExtension(fileObj) {
  const mimeType = (fileObj?.type || '').toLowerCase();
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/svg+xml') return '.svg';
  return '.png';
}

function getScreenshotBaseName() {
  const date = new Date().toISOString().slice(0, 10);
  return `Screenshot ${date}`;
}

async function uploadImage(fileObj, options = {}) {
  if (!authStore.isAuthenticated) {
    uploadError.value = 'You must be logged in to upload images.';
    return;
  }
  isUploading.value = true;
  uploadError.value = '';
  try {
    const shouldRenameClipboardImage =
      options.isClipboard === true &&
      (!fileObj.name || fileObj.name.toLowerCase() === 'image.png');
    const screenshotBaseName = shouldRenameClipboardImage ? getScreenshotBaseName() : null;
    const uploadFilename = shouldRenameClipboardImage
      ? `${screenshotBaseName}${getScreenshotExtension(fileObj)}`
      : fileObj.name;

    const formData = new FormData();
    formData.append('image', fileObj, uploadFilename);

    const imageTarget = file.value?.dbKey?.startsWith('space:')
      ? `?space=${encodeURIComponent(file.value.dbKey.slice('space:'.length))}`
      : '';
    const response = await fetch(`${imageServiceUrl}/images${imageTarget}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authStore.token}`
      },
      body: formData
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Upload failed');
    }
    const data = await response.json();
    const finalUrl = isProduction ? `/api${data.url}` : `${imageServiceUrl}${data.url}`;
    const markdownLabel = screenshotBaseName || fileObj.name;
    insertAtCursor(`![${markdownLabel}](${finalUrl})\n`);
  } catch (err) {
    console.error('Image upload error:', err);
    uploadError.value = err.message || 'Failed to upload image.';
  } finally {
    isUploading.value = false;
  }
}

/* ───── insertion helpers ───── */
function getTextareaElement() {
  // Access the underlying textarea from Overtype instance
  if (!editorInstance.value || !editorContainerRef.value) return null;
  return editorContainerRef.value.querySelector('textarea');
}

function insertAtCursor(text) {
  const textarea = getTextareaElement();
  if (!textarea || !editorInstance.value) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const currentText = textarea.value;

  // Create new text with insertion
  const beforeCursor = currentText.slice(0, start);
  const afterCursor = currentText.slice(end);
  const newText = beforeCursor + text + afterCursor;

  // Update textarea directly
  textarea.value = newText;

  // Calculate new cursor position
  const newCursorPos = start + text.length;

  // Set cursor position BEFORE triggering input event
  textarea.setSelectionRange(newCursorPos, newCursorPos);

  // Trigger input event to sync with Overtype
  const inputEvent = new Event('input', { bubbles: true });
  textarea.dispatchEvent(inputEvent);

  // Ensure focus
  textarea.focus();
}

function insertFormat(prefix, suffix) {
  const textarea = getTextareaElement();
  if (!textarea || !editorInstance.value) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const currentText = textarea.value;
  const selectedText = currentText.slice(start, end);

  // Create formatted text
  const beforeSelection = currentText.slice(0, start);
  const afterSelection = currentText.slice(end);
  const formattedText = prefix + selectedText + suffix;
  const newText = beforeSelection + formattedText + afterSelection;

  // Update textarea directly
  textarea.value = newText;

  // Set selection to the original selected text (now formatted)
  const newStart = start + prefix.length;
  const newEnd = newStart + selectedText.length;
  textarea.setSelectionRange(newStart, newEnd);

  // Trigger input event to sync with Overtype
  const inputEvent = new Event('input', { bubbles: true });
  textarea.dispatchEvent(inputEvent);

  // Ensure focus
  textarea.focus();
}

function insertList(prefix) {
  insertAtCursor(prefix);
}

function insertLink() {
  insertAtCursor('[Link text](url)');
}

function insertTable() {
  const tpl = `\n| Header 1 | Header 2 |\n|----------|----------|\n| Cell 1   | Cell 2   |\n`;
  insertAtCursor(tpl);
}

function insertPageBreak() {
  insertAtCursor('\n\\pagebreak\n');
}

function insertCodeBlock() {
  insertAtCursor('\n```\n\n```\n');
}

function insertImagePlaceholder() {
  insertAtCursor('![Alt text](url)');
}

function insertImagesFromLibrary(images) {
  if (!Array.isArray(images) || images.length === 0) return;

  const markdown = images
    .filter((image) => image?.imageUrl)
    .map((image) => `![${image.filename || 'Image'}](${image.imageUrl})`)
    .join('\n');

  if (!markdown) return;
  insertAtCursor(`${markdown}\n`);
}

function insertText(text) {
  if (!text) return;

  const textarea = getTextareaElement();
  if (!textarea) return;

  const start = textarea.selectionStart;
  const previousChar = textarea.value.slice(Math.max(0, start - 1), start);
  const needsLeadingSpace = previousChar && !/\s/.test(previousChar) && !/^\s/.test(text);

  insertAtCursor(`${needsLeadingSpace ? ' ' : ''}${text}`);
}

/* ───── find / replace ───── */
function findNext(term) {
  if (!term?.trim()) return;
  const textarea = getTextareaElement();
  if (!textarea) return;

  const text = textarea.value;
  let fromIdx = textarea.selectionEnd;

  // Search from current position
  let idx = text.indexOf(term, fromIdx);

  // If not found, wrap around to beginning
  if (idx === -1) {
    idx = text.indexOf(term, 0);
  }

  if (idx > -1) {
    textarea.focus();
    textarea.setSelectionRange(idx, idx + term.length);

    // Scroll into view
    const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 20;
    const textBeforeCursor = text.substring(0, idx);
    const lineNumber = textBeforeCursor.split('\n').length;
    textarea.scrollTop = Math.max(0, (lineNumber - 5) * lineHeight);
  }
}

function replaceNext(term, repl) {
  if (!term?.trim()) return;
  const textarea = getTextareaElement();
  if (!textarea) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selectedText = textarea.value.substring(start, end);

  // If current selection matches the search term, replace it
  if (selectedText === term) {
    const currentText = textarea.value;
    const beforeSelection = currentText.slice(0, start);
    const afterSelection = currentText.slice(end);
    const newText = beforeSelection + repl + afterSelection;

    // Update textarea
    textarea.value = newText;

    // Set cursor after replacement
    const newCursorPos = start + repl.length;
    textarea.setSelectionRange(newCursorPos, newCursorPos);

    // Trigger input event to sync with Overtype
    const inputEvent = new Event('input', { bubbles: true });
    textarea.dispatchEvent(inputEvent);

    textarea.focus();
  } else {
    // If selection doesn't match, find next occurrence
    findNext(term);
  }
}

function replaceAll(term, repl) {
  if (!term?.trim()) return;
  const textarea = getTextareaElement();
  if (!textarea || !editorInstance.value) return;

  const currentText = textarea.value;
  const newText = currentText.replaceAll(term, repl);

  if (currentText !== newText) {
    // Update textarea
    textarea.value = newText;

    // Trigger input event to sync with Overtype
    const inputEvent = new Event('input', { bubbles: true });
    textarea.dispatchEvent(inputEvent);

    textarea.focus();
  }
}

// Wrap your existing exposed methods
const insertFormatWrapped = wrapWithRecord(insertFormat);
const insertListWrapped = wrapWithRecord(insertList);
const insertLinkWrapped = wrapWithRecord(insertLink);
const insertTableWrapped = wrapWithRecord(insertTable);
const insertPageBreakWrapped = wrapWithRecord(insertPageBreak);
const insertCodeBlockWrapped = wrapWithRecord(insertCodeBlock);
const insertImagePlaceholderWrapped = wrapWithRecord(insertImagePlaceholder);
const insertImagesFromLibraryWrapped = wrapWithRecord(insertImagesFromLibrary);
const insertTextWrapped = wrapWithRecord(insertText);

// Helper wrappers for button enabling state
const canUndo = computed(() => file.value ? historyStore.canUndo(file.value.id) : false);
const canRedo = computed(() => file.value ? historyStore.canRedo(file.value.id) : false);

/* ───── expose methods for parent components ───── */
const exposedMethods = {
  insertFormat: insertFormatWrapped,
  insertList: insertListWrapped,
  insertLink: insertLinkWrapped,
  insertTable: insertTableWrapped,
  insertPageBreak: insertPageBreakWrapped,
  insertCodeBlock: insertCodeBlockWrapped,
  insertImagePlaceholder: insertImagePlaceholderWrapped,
  insertImagesFromLibrary: insertImagesFromLibraryWrapped,
  insertText: insertTextWrapped,

  uploadImage,
  findNext,
  replaceNext,
  replaceAll,

  undo: performUndo,
  redo: performRedo,
  canUndo,
  canRedo,
};

defineExpose(exposedMethods);

/* ───── register/unregister with global store ───── */
onMounted(() => {
  nextTick(() => {
    initEditor();
  });
  editorStore.setEditorRef(exposedMethods);
});

onUnmounted(() => {
  if (collabActive.value) collabStore.leave();
  destroyEditor();
  editorStore.clearEditorRef();
});
</script>
