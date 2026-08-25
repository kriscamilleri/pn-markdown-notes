<!-- frontend/src/components/DocumentDashboard.vue -->
<template>
    <!--
        One dashboard for two scopes. `folderId === '__recent__'` is the global
        Recent Documents view; anything else is a folder view. Header, pinned
        Continue Writing cards, toolbar, rows, grouping, and empty states are
        shared so the two cannot drift.
    -->
    <div
        class="flex-1 overflow-hidden px-4 py-4 lg:px-6"
        :data-testid="isGlobal ? 'document-dashboard-recent' : `document-dashboard-folder-${folderId}`"
    >
        <DocumentDashboardHeader
            v-model="query"
            :title="pageTitle"
            :search-label="searchLabel"
            :title-testid="isGlobal ? 'folder-preview-recent-heading' : `folder-preview-name-${folderId}`"
            :scope-key="isGlobal ? 'recent' : folderId"
            @new-note="openCreateModal"
            @new-from-template="showTemplatePicker = true"
        />

        <!--
            Continue Writing: the three most recently modified pinned documents
            in the current scope. The cards carry the section on their own — no
            panel chrome or heading around them — so the grid itself is what
            renders conditionally when the scope has no pinned documents.

            The rail also steps aside while the quick filter is in use: when the
            user is searching, the answer is the list, and repeating its first
            three hits as cards just pushes that list down the page.
        -->
        <div
            v-if="showContinueWriting"
            class="my-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
            role="group"
            aria-label="Continue writing"
            data-testid="continue-writing-section"
        >
            <RecentDocumentCard
                v-for="doc in continueWriting"
                :key="`${doc.dbKey}:${doc.id}`"
                :document="doc"
                :now="now"
                @open="openDocument"
                @toggle-pin="togglePin"
            />
        </div>

        <!-- Toolbar -->
        <div class="mb-3 flex flex-wrap items-center gap-2">
            <h3
                v-if="!isGlobal"
                class="mr-auto pn-title-section"
                data-testid="document-dashboard-list-heading"
            >
                Documents
            </h3>

            <label
                class="sr-only"
                :for="`document-sort-${scopeKey}`"
            >Sort documents</label>
            <select
                :id="`document-sort-${scopeKey}`"
                v-model="sortOrder"
                class="pn-select w-auto"
                data-testid="document-dashboard-sort"
            >
                <option :value="SORT_NEWEST_FIRST">Modified, newest first</option>
                <option :value="SORT_OLDEST_FIRST">Modified, oldest first</option>
                <option :value="SORT_CREATED_NEWEST_FIRST">Created, newest first</option>
                <option :value="SORT_CREATED_OLDEST_FIRST">Created, oldest first</option>
            </select>

            <!-- A pressed-state shortcut for the same filter; the two stay in sync. -->
            <BaseButton
                variant="secondary"
                :is-active="showPinnedOnly"
                class="pinned-filter-toggle"
                :aria-pressed="showPinnedOnly"
                aria-label="Show pinned documents only"
                title="Show pinned documents only"
                data-testid="document-dashboard-pinned-toggle"
                @click="togglePinnedFilter"
            >
                <Star
                    class="h-4 w-4"
                    :fill="showPinnedOnly ? 'currentColor' : 'none'"
                    aria-hidden="true"
                />
                <span>Pinned</span>
            </BaseButton>
        </div>

        <FolderNavigationList
            v-if="!isGlobal"
            :folders="childFolders"
            @open-folder="openFolder"
        />

        <p
            class="sr-only"
            role="status"
            aria-live="polite"
            data-testid="document-dashboard-result-count"
        >
            {{ resultCountLabel }}
        </p>

        <div
            v-if="isLoading"
            class="pn-body"
            data-testid="document-dashboard-loading"
        >
            Loading documents...
        </div>

        <!-- Nothing in this scope at all. -->
        <div
            v-else-if="documents.length === 0"
            class="pn-panel-muted p-6 text-center"
            data-testid="document-dashboard-empty"
        >
            <p class="pn-body">{{ emptyScopeMessage }}</p>
        </div>

        <!-- Documents exist, but the active filters match none of them. -->
        <div
            v-else-if="groups.length === 0"
            class="pn-panel-muted p-6 text-center"
            data-testid="document-dashboard-no-matches"
        >
            <p class="pn-body">{{ noMatchesMessage }}</p>
            <BaseButton
                variant="secondary"
                size="md"
                class="mt-3"
                data-testid="document-dashboard-clear-filters"
                @click="clearFilters"
            >
                Clear filters
            </BaseButton>
        </div>

        <template v-else>
            <section
                v-for="group in groups"
                :key="group.key"
                class="mb-4"
                :data-testid="`document-group-${group.key}`"
            >
                <h4
                    class="border-b pn-divider pb-1 uppercase tracking-wide pn-meta"
                    :data-testid="`document-group-label-${group.key}`"
                >
                    {{ group.label }}
                </h4>

                <ul class="divide-y divide-gray-100">
                    <RecentDocumentRow
                        v-for="doc in group.documents"
                        :key="`${doc.dbKey}:${doc.id}`"
                        :document="doc"
                        :now="now"
                        @open="openDocument"
                        @toggle-pin="togglePin"
                    />
                </ul>
            </section>
        </template>

        <PromptModal
            v-if="showCreateModal"
            v-model="newNoteName"
            title="Create New Document"
            label="Document name"
            placeholder="Enter document name"
            confirm-label="Create"
            data-testid="document-dashboard-create-modal"
            input-testid="document-dashboard-create-modal-input"
            cancel-testid="document-dashboard-create-modal-cancel"
            confirm-testid="document-dashboard-create-modal-confirm"
            @confirm="confirmCreate"
            @cancel="cancelCreate"
        />

        <TemplatePickerModal
            v-if="showTemplatePicker"
            :current-folder-id="isGlobal ? null : folderId"
            :database-key="isGlobal ? docStore.syncStore.personalDbKey : currentDbKey"
            @close="showTemplatePicker = false"
            @created="openDocument"
        />
    </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Star } from 'lucide-vue-next'

import BaseButton from '@/components/BaseButton.vue'
import DocumentDashboardHeader from '@/components/DocumentDashboardHeader.vue'
import FolderNavigationList from '@/components/FolderNavigationList.vue'
import PromptModal from '@/components/PromptModal.vue'
import RecentDocumentCard from '@/components/RecentDocumentCard.vue'
import RecentDocumentRow from '@/components/RecentDocumentRow.vue'
import TemplatePickerModal from '@/components/TemplatePickerModal.vue'

import { useDocStore } from '@/store/docStore'
import { useDraftStore } from '@/store/draftStore'
import { useUiStore } from '@/store/uiStore'
import {
    FILTER_ALL,
    FILTER_PINNED,
    SORT_NEWEST_FIRST,
    SORT_OLDEST_FIRST,
    SORT_CREATED_NEWEST_FIRST,
    SORT_CREATED_OLDEST_FIRST,
    buildDashboardView,
    sortRecentDocuments,
} from '@/utils/recentDocuments.js'

const props = defineProps({
    /** `'__recent__'` for the global dashboard, otherwise a real folder id. */
    folderId: { type: String, default: null },
})

const RECENT_SCOPE = '__recent__'
/** Bounded query size; filtering and sorting then happen in memory. */
const DOCUMENT_LIMIT = 50

const router = useRouter()
const docStore = useDocStore()
const draftStore = useDraftStore()
const ui = useUiStore()

const isGlobal = computed(() => props.folderId === RECENT_SCOPE || !props.folderId)
const scopeKey = computed(() => (isGlobal.value ? 'recent' : props.folderId))
const currentDbKey = computed(() => (
    isGlobal.value ? null : docStore.selectedDbKey
))

const documents = ref([])
const childFolders = ref([])
const folderName = ref('Folder')
const isLoading = ref(true)
const now = ref(Date.now())

const query = ref('')
const filter = ref(FILTER_ALL)
const sortOrder = ref(SORT_NEWEST_FIRST)

const showPinnedOnly = computed(() => filter.value === FILTER_PINNED)

const pageTitle = computed(() => (isGlobal.value ? 'Recent Documents' : folderName.value))
const searchLabel = computed(() => (isGlobal.value ? 'Search recent documents' : 'Search this folder'))
const emptyScopeMessage = computed(() =>
    isGlobal.value ? 'No documents yet.' : 'No documents in this folder yet.'
)
const noMatchesMessage = computed(() =>
    isGlobal.value
        ? 'No recent documents match these filters.'
        : 'No documents in this folder match these filters.'
)

const view = computed(() =>
    buildDashboardView(documents.value, {
        query: query.value,
        filter: filter.value,
        sortOrder: sortOrder.value,
        now: now.value,
    })
)

const groups = computed(() => view.value.groups)
/**
 * The three most recently modified pinned documents. They stay in the list below
 * too — duplication is intentional so a user can resume or scan.
 */
const continueWriting = computed(() =>
    sortRecentDocuments(
        documents.value.filter((doc) => doc.isPinned),
        SORT_NEWEST_FIRST
    ).slice(0, 3)
)

/**
 * Never render while the quick filter is narrowing the list: during a search
 * the list is the answer, so the rail would only repeat its first three hits
 * and push the results down.
 */
const showContinueWriting = computed(
    () => !query.value.trim() && continueWriting.value.length > 0
)

const resultCountLabel = computed(() => {
    const count = view.value.documents.length
    return `${count} ${count === 1 ? 'document' : 'documents'} shown`
})

/*
 * Load guard: a slower earlier request must never overwrite a newer result.
 */
let loadToken = 0

async function loadDocuments(token) {
    const rows = isGlobal.value
        ? await docStore.getRecentDocuments(DOCUMENT_LIMIT)
        : await docStore.getFolderDocuments(
            props.folderId === currentDbKey.value ? null : props.folderId,
            currentDbKey.value,
            DOCUMENT_LIMIT,
        )

    if (token !== loadToken) return

    documents.value = rows
    now.value = Date.now()
    isLoading.value = false
}

async function loadFolderContext(token) {
    if (isGlobal.value) {
        childFolders.value = []
        folderName.value = ''
        return
    }

    const [nameRows, children] = await Promise.all([
        props.folderId === currentDbKey.value
            ? Promise.resolve([{ name: docStore.syncStore.databases.get(currentDbKey.value)?.name }])
            : docStore.syncStore.repository(currentDbKey.value)
                .execute('SELECT name FROM folders WHERE id = ?', [props.folderId]),
        docStore.getChildren(props.folderId, currentDbKey.value),
    ])

    if (token !== loadToken) return

    folderName.value = nameRows?.[0]?.name || 'Folder'
    childFolders.value = (children || [])
        .filter((child) => child.type === 'folder')
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
}

async function refresh() {
    const token = ++loadToken
    isLoading.value = true
    await Promise.all([loadDocuments(token), loadFolderContext(token)])
}

watch(
    () => [
        props.folderId,
        docStore.syncStore.isInitialized,
        docStore.recentDocVersion,
        docStore.contentVersion,
    ],
    () => { refresh() },
    { immediate: true }
)

// A scope change is a different dashboard: start from unfiltered state.
watch(() => props.folderId, () => {
    query.value = ''
    filter.value = FILTER_ALL
    sortOrder.value = SORT_NEWEST_FIRST
})

function togglePinnedFilter() {
    filter.value = showPinnedOnly.value ? FILTER_ALL : FILTER_PINNED
}

function clearFilters() {
    query.value = ''
    filter.value = FILTER_ALL
}

async function openDocument(document) {
    draftStore.clearDraft(document.id)
    await docStore.selectFile(document.id, document.dbKey)
    router.push({ name: 'doc', params: { fileId: document.id }, query: { dbKey: document.dbKey } })
}

async function openFolder(folder) {
    await docStore.selectFolder(folder.id, folder.dbKey)
    router.push({ name: 'folder', params: { folderId: folder.id }, query: { dbKey: folder.dbKey } })
}

/**
 * Optimistic pin toggle. A failed write is reverted, reported through the
 * shared toast system, and followed by a reload so the UI never claims a pin
 * state the database does not hold.
 */
async function togglePin(doc) {
    const nextPinned = !doc.isPinned
    const index = documents.value.findIndex((entry) => entry.id === doc.id)
    if (index === -1) return

    documents.value[index] = { ...documents.value[index], isPinned: nextPinned }

    try {
        await docStore.setDocumentPinned(doc.id, nextPinned, doc.dbKey)
    } catch (error) {
        console.error('Failed to update pin state:', error)
        const current = documents.value.findIndex((entry) => entry.id === doc.id)
        if (current !== -1) {
            documents.value[current] = { ...documents.value[current], isPinned: !nextPinned }
        }
        ui.addToast(nextPinned ? 'Failed to pin document' : 'Failed to unpin document', 'error')
        await refresh()
    }
}

/* New document — the same prompt and creation action as the Documents pane. */
const showCreateModal = ref(false)
const showTemplatePicker = ref(false)
const newNoteName = ref('')

function openCreateModal() {
    newNoteName.value = ''
    showCreateModal.value = true
}

function cancelCreate() {
    showCreateModal.value = false
    newNoteName.value = ''
}

async function confirmCreate() {
    const name = newNoteName.value.trim()
    if (!name) return

    try {
        const dbKey = isGlobal.value ? docStore.syncStore.personalDbKey : currentDbKey.value
        const parentId = isGlobal.value || props.folderId === dbKey ? null : props.folderId
        const created = await docStore.createFile(dbKey, name, parentId)
        if (created?.id) {
            draftStore.clearDraft(created.id)
            await docStore.selectFile(created.id, created.dbKey)
            router.push({ name: 'doc', params: { fileId: created.id }, query: { dbKey: created.dbKey } })
        }
    } catch (error) {
        console.error('Failed to create document:', error)
        ui.addToast('Failed to create document', 'error')
    } finally {
        cancelCreate()
    }
}
</script>

<style scoped>
.pinned-filter-toggle:not([aria-pressed='true']):hover {
    background-color: #f3f4f6;
}

.pinned-filter-toggle[aria-pressed='true'] {
    background-color: #e5e7eb;
}

.pinned-filter-toggle[aria-pressed='true']:hover {
    background-color: #d1d5db;
}
</style>
