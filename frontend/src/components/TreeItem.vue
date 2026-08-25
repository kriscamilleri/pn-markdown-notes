<template>
    <div>
        <div
            v-if="showContextMenu"
            class="fixed z-50 min-w-[10rem] rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg"
            :style="{ top: contextMenuY + 'px', left: contextMenuX + 'px' }"
            :data-testid="`tree-item-context-menu-${item.id}`"
        >
            <button
                v-if="isSpace"
                @click="handleManageSpace"
                class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100"
                :data-testid="`tree-item-context-menu-manage-${item.id}`"
            >
                <Settings class="h-4 w-4" />
                <span>Manage space</span>
            </button>

            <button
                v-if="!isSpace"
                @click="handleRename"
                class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100"
                :data-testid="`tree-item-context-menu-rename-${item.id}`"
            >
                <Edit class="h-4 w-4" />
                <span>Rename</span>
            </button>

            <div v-if="!isSpace" class="my-1 border-t border-gray-200" />

            <button
                v-if="!isSpace"
                @click="handleDuplicate"
                class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100"
                :data-testid="`tree-item-context-menu-duplicate-${item.id}`"
            >
                <Copy class="h-4 w-4" />
                <span>Duplicate</span>
            </button>

            <button
                v-if="!isSpace"
                @click="handleDelete"
                class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-red-600 transition-colors hover:bg-red-50"
                :data-testid="`tree-item-context-menu-delete-${item.id}`"
            >
                <Trash2 class="h-4 w-4" />
                <span>Delete</span>
            </button>

            <template v-if="isFolder">
                <div class="my-1 border-t border-gray-200" />

                <button
                    @click="handleNewFile"
                    class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100"
                    :data-testid="`tree-item-context-menu-new-file-${item.id}`"
                >
                    <FilePlus class="h-4 w-4" />
                    <span>New Document</span>
                </button>
                <button
                    @click="handleNewFolder"
                    class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100"
                    :data-testid="`tree-item-context-menu-new-folder-${item.id}`"
                >
                    <FolderPlus class="h-4 w-4" />
                    <span>New Folder</span>
                </button>
            </template>
        </div>

        <div
            v-if="isFolder"
            class="flex items-center space-x-2 group rounded-md py-1 md:my-1 cursor-pointer"
            :class="{
                'bg-gray-700 text-white': isSelectedFolder,
                'bg-gray-600 text-white': isParentOfSelectedFile,
                'hover:bg-gray-100': !isSelectedFolder && !isParentOfSelectedFile
            }"
            :draggable="!isSpace"
            @dragstart="handleDragStart"
            @dragover.prevent.stop
            @drop.prevent.stop="handleDrop"
            @click.stop="handleFolderClick"
            :data-testid="`tree-item-folder-${item.id}`"
        >

            <span
                @click.stop="toggleLocalFolderState"
                class="cursor-pointer ml-1 p-1 rounded hover:bg-gray-300"
                :data-testid="`tree-item-folder-toggle-${item.id}`"
            >
                <ChevronDown
                    v-if="isOpen"
                    class="w-4 h-4"
                />
                <ChevronRight
                    v-else
                    class="w-4 h-4"
                />
            </span>

            <span
                class="font-semibold flex-grow truncate"
                :data-testid="`tree-item-folder-name-${item.id}`"
            >
                <Users v-if="isSpace" class="inline-block w-4 h-4 mr-1" />
                <Folder v-else class="inline-block w-4 h-4 mr-1" />{{ item.name }}
            </span>

            <AvatarStack
                v-if="isSpace && item.members?.length"
                :users="item.members"
                :max="3"
                size="xs"
                class="mr-1"
            />

            <button
                v-if="!isFiltered"
                class="transition-opacity px-2 rounded flex-shrink-0"
                :class="{
                    'opacity-100': shouldShowContextButton,
                    'opacity-0 group-hover:opacity-100 focus-within:opacity-100': !shouldShowContextButton
                }"
                @click.stop="showMenu($event)"
                :data-testid="`tree-item-folder-menu-${item.id}`"
            >
                <MoreHorizontal class="w-4 h-4" />
            </button>
        </div>

        <div
            v-if="isSpace && item.status && item.status !== 'ready'"
            class="ml-7 mr-1 rounded-md bg-amber-50 px-2 py-2 text-xs text-amber-800"
            :data-testid="`space-recovery-${item.dbKey}`"
        >
            <p>{{ item.error || 'This space is not ready on this device.' }}</p>
            <div class="mt-1 flex gap-2">
                <button class="font-semibold underline" @click="retrySpace">Retry</button>
                <button class="font-semibold underline" @click="removeSpace">Remove locally</button>
            </div>
        </div>

        <div
            v-if="!isFolder"
            class="flex items-center space-x-2 cursor-pointer group rounded-md pl-1 hover:bg-gray-100"
            :class="{
                'ml-6': isFiltered,
                'bg-gray-200 hover:bg-gray-300': isSelectedFile
            }"
            draggable="true"
            @dragstart="handleDragStart"
            @dragover.prevent
            @click="handleFileClick(item.id)"
            @contextmenu.prevent="showMenu($event)"
            :data-testid="`tree-item-file-${item.id}`"
        >

            <File class="w-4 h-4 ml-1 flex-shrink-0" />
            <span
                class="flex-grow truncate"
                :data-testid="`tree-item-file-name-${item.id}`"
            >{{ item.name }}</span>

            <span
                v-if="hasConflict"
                class="h-2 w-2 flex-shrink-0 rounded-full bg-amber-500"
                :title="'Unresolved changes'"
                :aria-label="'Unresolved changes'"
                :data-testid="`tree-item-conflict-${item.id}`"
            ></span>

            <button
                v-if="!isFiltered"
                class="transition-opacity px-2 rounded flex-shrink-0"
                :class="{
                    'opacity-100': isSelectedFile,
                    'opacity-0 group-hover:opacity-100 focus-within:opacity-100': !isSelectedFile
                }"
                @click.stop="showMenu($event)"
                :data-testid="`tree-item-file-menu-${item.id}`"
            >
                <MoreHorizontal class="w-4 h-4" />
            </button>
        </div>

        <ul
            v-if="isFolder && isOpen"
            class="ml-6 mt-1 border-l pl-2"
        >
            <template v-if="isFiltered">
                <li
                    v-for="file in matchingFiles"
                    :key="file.treeKey || file.id"
                    class="mb-1"
                >
                    <TreeItem
                        :item="file"
                        :is-filtered="true"
                    />
                </li>
                <li v-if="matchingFiles.length === 0 && children.some(c => c.type === 'file')">
                    <div class="text-xs text-gray-500 pl-2">(Documents inside matching folder)</div>
                    <TreeItem
                        v-for="child in children.filter(c => c.type === 'file')"
                        :key="child.treeKey || child.id"
                        :item="child"
                        :is-filtered="true"
                    />
                </li>
            </template>
            <template v-else>
                <li
                    v-for="child in children"
                    :key="child.treeKey || child.id"
                    class="mb-1"
                >
                    <TreeItem
                        :item="child"
                        :is-filtered="false"
                    />
                </li>
            </template>
        </ul>

        <PromptModal
            v-if="showCreateModal"
            v-model="newItemName"
            :title="`Create New ${createType} in &quot;${item.name}&quot;`"
            :label="`${createType} name`"
            :placeholder="'Enter ' + createType + ' name'"
            confirm-label="Create"
            :data-testid="`tree-item-create-modal-${item.id}`"
            :input-testid="`tree-item-create-modal-input-${item.id}`"
            :cancel-testid="`tree-item-create-modal-cancel-${item.id}`"
            :confirm-testid="`tree-item-create-modal-confirm-${item.id}`"
            @confirm="confirmCreate"
            @cancel="cancelCreate"
        />

        <PromptModal
            v-if="showRenameModal"
            v-model="renameItemName"
            :title="`Rename ${renameType}`"
            :label="`New ${renameType} name`"
            :placeholder="'Enter new ' + renameType + ' name'"
            confirm-label="Rename"
            :data-testid="`tree-item-rename-modal-${item.id}`"
            :input-testid="`tree-item-rename-modal-input-${item.id}`"
            :cancel-testid="`tree-item-rename-modal-cancel-${item.id}`"
            :confirm-testid="`tree-item-rename-modal-confirm-${item.id}`"
            @confirm="confirmRename"
            @cancel="cancelRename"
        />
    </div>
</template>

<script setup>
import { provide, computed, ref, onMounted, onUnmounted, watch, inject } from 'vue'
import { useRouter } from 'vue-router'
import { useDocStore } from '@/store/docStore'
import { useStructureStore } from '@/store/structureStore'
import { useConflictStore } from '@/store/conflictStore'
import { useSyncStore } from '@/store/syncStore'
import { useUiStore } from '@/store/uiStore'
import PromptModal from '@/components/PromptModal.vue'
import AvatarStack from '@/components/AvatarStack.vue'

import {
    Trash2, FilePlus, FolderPlus, MoreHorizontal,
    ChevronRight, ChevronDown, Folder, File, Edit, Copy, Users, Settings
} from 'lucide-vue-next'

const props = defineProps({
    item: { type: Object, required: true },
    isFiltered: { type: Boolean, default: false },
    matchingFiles: { type: Array, default: () => [] }
})

const docStore = useDocStore()
const structureStore = useStructureStore()
const conflictStore = useConflictStore()
const syncStore = useSyncStore()
const ui = useUiStore()
const router = useRouter()

const children = ref([]);
const isSpace = computed(() => props.item.type === 'space')
const isFolder = computed(() => props.item.type === 'folder' || isSpace.value)
const localFolderState = ref(props.isFiltered)

const isOpen = computed(() =>
    isFolder.value
        ? (props.isFiltered ? localFolderState.value : docStore.isFolderOpen(props.item.id, props.item.dbKey))
        : false)

async function fetchChildren() {
    if (isFolder.value) {
        children.value = await docStore.getChildren(props.item.id, props.item.dbKey);
    }
}

watch(isOpen, (newVal) => {
    if (newVal) {
        fetchChildren();
    }
});

onMounted(() => {
    if (isOpen.value) {
        fetchChildren();
    }
});

const isSelectedFile = computed(() =>
    !isFolder.value && docStore.selectedFileId === props.item.id)

const isParentOfSelectedFile = computed(() => {
    if (!isFolder.value || !docStore.selectedFile) return false
    return docStore.selectedFile.folder_id === props.item.id;
})

const isSelectedFolder = computed(() =>
    isFolder.value && docStore.selectedFolderId === props.item.id)

const hasConflict = computed(() =>
    !isFolder.value && conflictStore.hasConflict(props.item.id, props.item.dbKey))

const shouldShowContextButton = computed(() =>
    isSelectedFolder.value || isParentOfSelectedFile.value || isSelectedFile.value)


/* ──────────────────────────────
   ▸ DRAG-AND-DROP
────────────────────────────── */
const refreshParent = inject('refreshParent', () => { });
const requestDatabaseTransfer = inject('requestDatabaseTransfer', () => { });

function handleDragStart(e) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/json', JSON.stringify(props.item))
}

async function handleDrop(e) {
    const droppedItem = JSON.parse(e.dataTransfer.getData('application/json'))
    if (!droppedItem || !droppedItem.id) return
    if (droppedItem.id === props.item.id) return

    let oldParentId
    try {
        const result = await structureStore.moveItem(
            droppedItem.id,
            props.item.id,
            droppedItem.type,
            props.item.dbKey,
        )
        if (result?.requiresConfirmation) {
            requestDatabaseTransfer(result)
            return
        }
        oldParentId = result?.oldParentId
    } catch (error) {
        ui.addToast(error?.message || 'Failed to move Document.', 'warning')
        return
    }

    await fetchChildren(); // Refresh this folder (the destination)

    // To refresh the source folder, we rely on the parent providing a refresh function.
    if (oldParentId !== props.item.id) {
        refreshParent();
    }
}

provide('refreshParent', fetchChildren);

/* ──────────────────────────────
   ▸ FOLDER / FILE CLICK
────────────────────────────── */
function toggleLocalFolderState() {
    if (props.isFiltered) {
        localFolderState.value = !localFolderState.value;
    } else {
        docStore.toggleFolder(props.item.id, props.item.dbKey);
    }
}

function handleFolderClick() {
    docStore.selectFolder(props.item.id, props.item.dbKey)
    router.push({ name: 'folder', params: { folderId: props.item.id }, query: { dbKey: props.item.dbKey } })
}

function handleFileClick(id) {
    docStore.selectFile(id, props.item.dbKey)
    router.push({ name: 'doc', params: { fileId: id }, query: { dbKey: props.item.dbKey } })
}

/* ──────────────────────────────
   ▸ CONTEXT-MENU & MODALS
────────────────────────────── */
const showContextMenu = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)

function showMenu(event) {
    if (props.isFiltered) return
    contextMenuX.value = event.clientX
    contextMenuY.value = event.clientY
    showContextMenu.value = true
    event.preventDefault()
}

function handleManageSpace() {
    showContextMenu.value = false
    router.push({ name: 'spaces', query: { space: props.item.id } })
}

async function handleDuplicate() {
    if (props.item.type === 'file') {
        const result = await docStore.duplicateFile(props.item.id, props.item.dbKey)
        if (result) {
            refreshParent()
        }
    }
    showContextMenu.value = false
}

async function handleDelete() {
    if (props.item.id === 'welcome' || props.item.id.startsWith('welcome-')) {
        alert("The default 'Welcome' item cannot be deleted.")
        showContextMenu.value = false
        return
    }
    if (confirm(`Delete "${props.item.name}"? This cannot be undone.`)) {
        await docStore.deleteItem(props.item.id, props.item.type, props.item.dbKey)
        refreshParent(); // Tell parent to refresh its list
    }
    showContextMenu.value = false
}

/* create-modal */
const showCreateModal = ref(false)
const createType = ref('')
const newItemName = ref('')

function handleNewFile() { openCreate('Document') }
function handleNewFolder() { openCreate('Folder') }
function openCreate(type) {
    createType.value = type
    showCreateModal.value = true
    showContextMenu.value = false
}
async function confirmCreate() {
    if (!newItemName.value.trim()) return
    const action = createType.value === 'Document'
        ? docStore.createFile(props.item.dbKey, newItemName.value, props.item.id)
        : docStore.createFolder(props.item.dbKey, newItemName.value, props.item.id)

    await action;
    await fetchChildren(); // Refresh this item's children

    cancelCreate()
}
function cancelCreate() {
    showCreateModal.value = false
    newItemName.value = ''
    createType.value = ''
}

/* rename-modal */
const showRenameModal = ref(false)
const renameType = ref('')
const renameItemName = ref('')

function handleRename() {
    if (props.item.id === 'welcome' || props.item.id.startsWith('welcome-')) {
        alert("The default 'Welcome' item cannot be renamed.")
        showContextMenu.value = false
        return
    }
    renameType.value = props.item.type === 'file' ? 'Document' : 'Folder'
    renameItemName.value = props.item.name
    showRenameModal.value = true
    showContextMenu.value = false
}
async function confirmRename() {
    const trimmed = renameItemName.value.trim()
    if (trimmed && trimmed !== props.item.name) {
        await docStore.renameItem(props.item.id, trimmed, props.item.type, props.item.dbKey)
        refreshParent();
    }
    cancelRename()
}
function cancelRename() {
    showRenameModal.value = false
    renameItemName.value = ''
    renameType.value = ''
}

function handleClickOutside() {
    if (showContextMenu.value) {
        showContextMenu.value = false
    }
}

async function retrySpace() {
    await syncStore.retryBootstrap(props.item.dbKey)
    await docStore.loadRootItems()
}

async function removeSpace() {
    await syncStore.removeDatabase(props.item.dbKey)
    await docStore.loadRootItems()
}

onMounted(() => document.addEventListener('click', handleClickOutside, true))
onUnmounted(() => document.removeEventListener('click', handleClickOutside, true))
</script>

<style scoped>
.truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
