<template>
    <div
        class="h-full flex flex-col"
        @dragover.prevent
        @drop="handleRootDrop"
    >
        <div class="flex justify-between items-center mb-4">
            <h2
                class="font-bold text-lg cursor-pointer"
                @click="handleDocumentsClick"
                data-testid="documents-header"
            >
                Documents
            </h2>
            <div class="flex space-x-2">
                <BaseButton
                    :isActive="showSearch"
                    @click="toggleSearch"
                    title="Toggle Search"
                    data-testid="documents-search-toggle"
                >
                    <Search class="w-4 h-4" />
                </BaseButton>

                <BaseButton
                    @click="showCreateFileModal"
                    title="New Document"
                    data-testid="documents-new-file-button"
                >
                    <FilePlus class="w-4 h-4" />
                </BaseButton>

                <BaseButton
                    @click="showCreateFolderModal"
                    title="New Folder"
                    data-testid="documents-new-folder-button"
                >
                    <FolderPlus class="w-4 h-4" />
                </BaseButton>

                <BaseButton
                    @click="showTemplatePicker = true"
                    title="New from Template"
                    data-testid="documents-new-from-template-button"
                >
                    <FileText class="w-4 h-4" />
                </BaseButton>
            </div>
        </div>

        <div
            v-if="showSearch"
            class="mb-4 overflow-hidden transition-all duration-200"
            :class="{ 'opacity-100': showSearch, 'opacity-0': !showSearch }"
        >
            <div class="relative">
                <Search class="absolute left-2.5 top-2.5 w-4 h-4 text-gray-400" />
                <input
                    v-model="searchQuery"
                    type="text"
                    placeholder="Search documents and folders..."
                    class="w-full px-8 py-2 border rounded-lg focus:outline-none focus:border-blue-500"
                    ref="searchInput"
                    data-testid="documents-search-input"
                />
                <button
                    v-if="searchQuery"
                    @click="clearSearch"
                    class="absolute right-2.5 top-2.5 text-gray-400 hover:text-gray-600"
                    data-testid="documents-search-clear"
                >
                    <X class="w-4 h-4" />
                </button>
            </div>
        </div>

        <div class="flex-1 overflow-y-auto">
            <DocumentTransferPanel />
            <div
                v-if="docStore.syncStore.bootstrapState.status === 'loading'"
                class="mb-2 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800"
                role="status"
                data-testid="space-bootstrap-progress"
            >
                Loading shared space {{ docStore.syncStore.bootstrapState.completed + 1 }}
                of {{ docStore.syncStore.bootstrapState.total }}…
            </div>
            <div
                v-else-if="docStore.syncStore.bootstrapState.status === 'upgrade-required'"
                class="mb-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800"
                role="alert"
                data-testid="space-bootstrap-upgrade-required"
            >
                {{ docStore.syncStore.bootstrapState.error }}
            </div>
            <div
                v-if="searchQuery"
                data-testid="documents-tree-search"
            >
                <div v-if="filteredStructure.length > 0">
                    <ul class="space-y-1">
                        <li
                            v-for="item in filteredStructure"
                            :key="item.treeKey || item.id"
                        >
                            <TreeItem
                                :item="item"
                                :is-filtered="true"
                                :matching-files="getMatchingFilesForItem(item)"
                            />
                        </li>
                    </ul>
                </div>
                <div
                    v-else
                    class="text-gray-500 text-center py-4"
                    data-testid="documents-no-matches"
                >
                    No matches found for "{{ searchQuery }}"
                </div>
            </div>
            <div
                v-else
                data-testid="documents-tree-normal"
            >
                <ul class="space-y-1">
                    <li
                        v-for="item in rootItems"
                        :key="item.treeKey || item.id"
                    >
                        <TreeItem
                            :item="item"
                            :is-filtered="false"
                        />
                    </li>
                </ul>
            </div>
        </div>

        <PromptModal
            v-if="showCreateModal"
            v-model="newItemName"
            :title="`Create New ${createType}`"
            :label="`${createType} name`"
            :placeholder="'Enter ' + createType + ' name'"
            confirm-label="Create"
            data-testid="documents-create-modal"
            input-testid="documents-create-modal-input"
            cancel-testid="documents-create-modal-cancel"
            confirm-testid="documents-create-modal-confirm"
            @confirm="confirmCreate"
            @cancel="cancelCreate"
        />

        <TemplatePickerModal
            v-if="showTemplatePicker"
            :current-folder-id="structureStore.selectedFolderId"
            :database-key="structureStore.selectedDbKey || docStore.syncStore.personalDbKey"
            @close="showTemplatePicker = false"
            @created="onNoteCreatedFromTemplate"
        />
    </div>
</template>

<script setup>
import { computed, ref, watch, nextTick, provide } from 'vue';
import { useRouter } from 'vue-router';
import { useDocStore } from '@/store/docStore';
import { useUiStore } from '@/store/uiStore';
import TreeItem from './TreeItem.vue'
import BaseButton from './BaseButton.vue'
import { Search, X, FilePlus, FolderPlus, FileText } from 'lucide-vue-next'
import TemplatePickerModal from '@/components/TemplatePickerModal.vue'
import PromptModal from '@/components/PromptModal.vue'
import { useStructureStore } from '@/store/structureStore'
import { useSpaceTransferStore } from '@/store/spaceTransferStore'
import DocumentTransferPanel from '@/components/DocumentTransferPanel.vue'

const docStore = useDocStore()
const ui = useUiStore();
const structureStore = useStructureStore()
const transferStore = useSpaceTransferStore()
const router = useRouter();

const rootItems = computed(() => docStore.rootItems)

provide('refreshParent', docStore.loadRootItems);
provide('requestDatabaseTransfer', (details) => transferStore.begin(details));

/* search / ui refs */
const searchQuery = ref('')
const showSearch = ref(false)
const searchInput = ref(null)

function toggleSearch() {
    showSearch.value = !showSearch.value
    showSearch.value && nextTick(() => searchInput.value?.focus())
    !showSearch.value && clearSearch()
}
function clearSearch() { searchQuery.value = '' }

/* filtering helpers */
function matchesSearch(text, query) { return (text || '').toLowerCase().includes(query.toLowerCase()) }

async function getAllFilesInFolder(f) {
    let res = [];
    const children = await docStore.getChildren(f.id, f.dbKey);
    for (const c of children) {
        if (c.type === 'file') {
            res.push(c);
        } else {
            res.push(...(await getAllFilesInFolder(c)));
        }
    }
    return res;
}

async function getImmediateFiles(f) {
    return (await docStore.getChildren(f.id, f.dbKey)).filter(c => c.type === 'file')
}

const filteredStructure = ref([])
const matchingFilesMap = ref({})

let searchVersion = 0
watch(searchQuery, async (query) => {
    if (!query) {
        filteredStructure.value = []
        matchingFilesMap.value = {}
        return
    }
    const version = ++searchVersion
    const results = []
    const filesMap = {}
    for (const item of rootItems.value) {
        if (version !== searchVersion) return
        if (item.type === 'file') {
            if (matchesSearch(item.name, query)) results.push(item)
        } else {
            const folderNameMatches = matchesSearch(item.name, query)
            let files
            if (folderNameMatches) {
                files = await getImmediateFiles(item)
            } else {
                files = (await getAllFilesInFolder(item)).filter(fi => matchesSearch(fi.name, query))
            }
            if (version !== searchVersion) return
            if (folderNameMatches || files.length > 0) {
                results.push(item)
                filesMap[item.id] = files
            }
        }
    }
    if (version !== searchVersion) return
    filteredStructure.value = results
    matchingFilesMap.value = filesMap
})

function getMatchingFilesForItem(item) {
    return matchingFilesMap.value[item.id] || []
}


/* create-modal helpers */
const showCreateModal = ref(false)
const showTemplatePicker = ref(false)
const createType = ref('')
const newItemName = ref('')
// PromptModal focuses its own input once mounted.
function showCreateFileModal() { createType.value = 'Document'; showCreateModal.value = true }
function showCreateFolderModal() { createType.value = 'Folder'; showCreateModal.value = true }

async function confirmCreate() {
    if (!newItemName.value.trim()) return

    try {
        let newItem;
        if (createType.value === 'Document') {
            newItem = await docStore.createFile(docStore.syncStore.personalDbKey, newItemName.value)
            if (newItem && newItem.id) {
                await nextTick() // Wait for DOM updates
                router.push({ name: 'doc', params: { fileId: newItem.id }, query: { dbKey: newItem.dbKey } })
            }
        } else {
            newItem = await docStore.createFolder(docStore.syncStore.personalDbKey, newItemName.value)
            if (newItem && newItem.id) {
                await nextTick()
                router.push({ name: 'folder', params: { folderId: newItem.id }, query: { dbKey: newItem.dbKey } })
            }
        }
    } catch (error) {
        console.error('Failed to create item:', error)
        ui.addToast(`Failed to create ${createType.value.toLowerCase()}`)
    } finally {
        cancelCreate()
    }
}
function cancelCreate() { showCreateModal.value = false; newItemName.value = ''; createType.value = '' }

function onNoteCreatedFromTemplate(note) {
    showTemplatePicker.value = false;
    router.push({ name: 'doc', params: { fileId: note.id }, query: { dbKey: note.dbKey } });
}

/* misc */
function handleDocumentsClick() { docStore.selectFolder(null, docStore.syncStore.personalDbKey) }

/* drag-and-drop root handler */
async function handleRootDrop(e) {
    const droppedItem = JSON.parse(e.dataTransfer.getData('application/json'))
    if (!droppedItem || !droppedItem.id) return
    try {
        const result = await docStore.moveItem(
            droppedItem.id,
            null,
            droppedItem.type,
            docStore.syncStore.personalDbKey,
        );
        if (result?.requiresConfirmation) {
            transferStore.begin(result);
            return;
        }
        await docStore.loadRootItems(); // Refresh root list
    } catch (error) {
        ui.addToast(error?.message || 'Failed to move Document.', 'warning')
    }
}
</script>
