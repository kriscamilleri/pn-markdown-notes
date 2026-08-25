<template>
    <BaseModal
        :show="show"
        :title="activeMode ? modeTitles[activeMode] : 'Import Data'"
        size="md"
        close-testid="import-modal-close-button"
        @close="handleClose"
    >
        <!-- ── Format selector (main view) ── -->
        <div
            v-if="!activeMode"
            class="space-y-3"
        >
            <OptionCard
                :icon="FileText"
                title="Markdown Files (.md)"
                description="Import one or more markdown files and update matching documents in place."
                data-testid="import-mode-markdown"
                @click="selectMode('markdown')"
            />

            <OptionCard
                :icon="FolderOpen"
                title="Markdown Folder"
                description="Import a directory of .md files, preserving folder structure and updating matching documents."
                data-testid="import-mode-directory"
                @click="selectMode('directory')"
            />

            <OptionCard
                :icon="Image"
                title="Document with Linked Images"
                description="Choose a local folder, then import one Markdown document and upload its linked images."
                data-testid="import-mode-document-images"
                @click="selectMode('document-images')"
            />

            <OptionCard
                :icon="Archive"
                title="ZIP Archive (.zip)"
                description="Import folders and .md files from a .zip archive, update matching documents, and restore bundled images from Panino exports."
                data-testid="import-mode-zip"
                @click="selectMode('zip')"
            />

            <OptionCard
                :icon="Braces"
                title="Panino / StackEdit JSON"
                data-testid="import-mode-json"
                @click="selectMode('json')"
            >
                Import folders and markdown documents from a Panino or StackEdit JSON export.
                <span class="font-medium text-amber-600">Images, settings, and variables are skipped.</span>
            </OptionCard>
        </div>

        <!-- ── Markdown files mode ── -->
        <div v-else-if="activeMode === 'markdown'">
            <div
                class="rounded-lg border-2 border-dashed p-8 text-center transition-colors"
                :class="isDragging ? 'border-gray-800 bg-gray-50' : 'border-gray-300 hover:border-gray-400'"
                @dragenter.prevent="isDragging = true"
                @dragleave.prevent="isDragging = false"
                @dragover.prevent
                @drop.prevent="handleMarkdownDrop"
                data-testid="import-modal-dropzone"
            >
                <div
                    v-if="isDragging"
                    class="font-medium text-gray-800"
                >Drop your .md files here</div>
                <div
                    v-else
                    class="space-y-2"
                >
                    <Upload class="mx-auto h-10 w-10 text-gray-400" />
                    <p class="font-medium text-gray-700">Drag and drop .md files here</p>
                    <p class="pn-body">or</p>
                    <input
                        type="file"
                        accept=".md"
                        multiple
                        @change="handleMarkdownFileSelect"
                        class="hidden"
                        ref="mdFileInput"
                    />
                    <BaseButton
                        variant="primary"
                        size="md"
                        data-testid="import-modal-choose-md-button"
                        @click="$refs.mdFileInput.click()"
                    >
                        Choose Files
                    </BaseButton>
                </div>
            </div>
            <p
                v-if="selectedFiles.length"
                class="mt-4 pn-body"
            >
                {{ selectedFiles.length }} file{{ selectedFiles.length !== 1 ? 's' : '' }} selected
            </p>
        </div>

        <!-- ── Directory mode ── -->
        <div v-else-if="activeMode === 'directory'">
            <div class="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center">
                <div class="space-y-2">
                    <FolderOpen class="mx-auto h-10 w-10 text-gray-400" />
                    <p class="font-medium text-gray-700">Select a folder to import</p>
                    <p class="pn-body">All .md files and folder structure will be preserved.</p>
                    <input
                        type="file"
                        webkitdirectory
                        @change="handleDirectorySelect"
                        class="hidden"
                        ref="dirInput"
                    />
                    <BaseButton
                        variant="primary"
                        size="md"
                        data-testid="import-modal-choose-dir-button"
                        @click="$refs.dirInput.click()"
                    >
                        Choose Folder
                    </BaseButton>
                </div>
            </div>
            <p
                v-if="selectedFiles.length"
                class="mt-4 pn-body"
            >
                {{ selectedFiles.length }} file{{ selectedFiles.length !== 1 ? 's' : '' }} found in directory
            </p>
        </div>

        <!-- ── Document with linked images mode ── -->
        <div v-else-if="activeMode === 'document-images'" class="space-y-4">
            <div
                v-if="!fileSystemAccessSupported"
                class="pn-alert pn-alert-error"
                data-testid="import-modal-filesystem-unsupported"
            >
                <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
                <p>This import requires a Chromium browser with File System Access API support.</p>
            </div>

            <template v-else>
                <div class="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center">
                    <FolderOpen class="mx-auto h-10 w-10 text-gray-400" />
                    <p class="mt-2 font-medium text-gray-700">Choose the folder containing the document and images</p>
                    <p class="mt-1 pn-body">Only linked images within this folder can be uploaded.</p>
                    <BaseButton
                        variant="primary"
                        size="md"
                        class="mt-4"
                        data-testid="import-modal-choose-document-folder-button"
                        @click="chooseDocumentSourceFolder"
                    >
                        Choose Folder
                    </BaseButton>
                </div>

                <div v-if="linkedDocuments.length" class="space-y-2">
                    <label class="pn-label" for="linked-document-select">Document to import</label>
                    <select
                        id="linked-document-select"
                        v-model="selectedLinkedDocumentPath"
                        class="pn-input"
                        data-testid="import-modal-linked-document-select"
                    >
                        <option disabled value="">Choose a document</option>
                        <option v-for="document in linkedDocuments" :key="document.path" :value="document.path">
                            {{ document.path }}
                        </option>
                    </select>
                </div>

                <p v-else-if="linkedSourceDirectory" class="pn-body">
                    No Markdown documents were found in {{ linkedSourceDirectory.name }}.
                </p>
            </template>
        </div>

        <!-- ── ZIP mode ── -->
        <div v-else-if="activeMode === 'zip'">
            <div
                class="rounded-lg border-2 border-dashed p-8 text-center transition-colors"
                :class="isDragging ? 'border-gray-800 bg-gray-50' : 'border-gray-300 hover:border-gray-400'"
                @dragenter.prevent="isDragging = true"
                @dragleave.prevent="isDragging = false"
                @dragover.prevent
                @drop.prevent="handleZipDrop"
                data-testid="import-modal-zip-dropzone"
            >
                <div
                    v-if="isDragging"
                    class="font-medium text-gray-800"
                >Drop your .zip file here</div>
                <div
                    v-else
                    class="space-y-2"
                >
                    <Archive class="mx-auto h-10 w-10 text-gray-400" />
                    <p class="font-medium text-gray-700">Drag and drop a .zip file here</p>
                    <p class="pn-body">or</p>
                    <input
                        type="file"
                        accept=".zip"
                        @change="handleZipFileSelect"
                        class="hidden"
                        ref="zipFileInput"
                    />
                    <BaseButton
                        variant="primary"
                        size="md"
                        data-testid="import-modal-choose-zip-button"
                        @click="$refs.zipFileInput.click()"
                    >
                        Choose ZIP File
                    </BaseButton>
                </div>
            </div>
            <p
                v-if="selectedZipFile"
                class="mt-4 pn-body"
            >Selected: {{ selectedZipFile.name }}</p>
        </div>

        <!-- ── JSON mode ── -->
        <div v-else-if="activeMode === 'json'">
            <div
                class="rounded-lg border-2 border-dashed p-8 text-center transition-colors"
                :class="isDragging ? 'border-gray-800 bg-gray-50' : 'border-gray-300 hover:border-gray-400'"
                @dragenter.prevent="isDragging = true"
                @dragleave.prevent="isDragging = false"
                @dragover.prevent
                @drop.prevent="handleJsonDrop"
            >
                <div
                    v-if="isDragging"
                    class="font-medium text-gray-800"
                >Drop your JSON file here</div>
                <div
                    v-else
                    class="space-y-2"
                >
                    <Upload class="mx-auto h-10 w-10 text-gray-400" />
                    <p class="font-medium text-gray-700">Drag and drop your JSON file here</p>
                    <p class="pn-body">or</p>
                    <input
                        type="file"
                        accept=".json"
                        @change="handleJsonFileSelect"
                        class="hidden"
                        ref="jsonFileInput"
                    />
                    <BaseButton
                        variant="primary"
                        size="md"
                        data-testid="import-modal-choose-file-button"
                        @click="$refs.jsonFileInput.click()"
                    >
                        Choose File
                    </BaseButton>
                </div>
            </div>

            <div class="mt-4">
                <label
                    class="pn-label"
                    for="import-json-textarea"
                >Or paste your JSON data here</label>
                <textarea
                    id="import-json-textarea"
                    v-model="jsonData"
                    rows="8"
                    placeholder="Paste your JSON data here..."
                    class="pn-textarea font-mono"
                    data-testid="import-modal-json-textarea"
                ></textarea>
            </div>

            <div class="mt-4 flex items-center gap-2">
                <input
                    id="stackedit-format"
                    type="checkbox"
                    v-model="isStackEditFormat"
                    class="pn-checkbox"
                    data-testid="import-modal-stackedit-toggle"
                >
                <label
                    for="stackedit-format"
                    class="text-sm text-gray-700"
                >Import from StackEdit format</label>
            </div>
        </div>

        <!-- ── Progress bar ── -->
        <div
            v-if="isImporting"
            class="mt-4"
        >
            <div class="mb-1 flex justify-between pn-body">
                <span>Importing...</span>
                <span>{{ progressCurrent }} / {{ progressTotal }}</span>
            </div>
            <div class="h-2 w-full rounded-full bg-gray-200">
                <div
                    class="h-2 rounded-full bg-gray-800 transition-all duration-150"
                    :style="{ width: progressPercent + '%' }"
                ></div>
            </div>
        </div>

        <!-- ── Error ── -->
        <div
            v-if="error"
            class="pn-alert pn-alert-error mt-4"
            data-testid="import-modal-error"
        >
            <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
            <p>{{ error }}</p>
        </div>

        <template #footer>
            <BaseButton
                v-if="activeMode"
                variant="secondary"
                size="md"
                class="mr-auto"
                :disabled="isImporting"
                data-testid="import-modal-back-button"
                @click="goBack"
            >
                Back
            </BaseButton>
            <BaseButton
                variant="secondary"
                size="md"
                :disabled="isImporting"
                data-testid="import-modal-cancel-button"
                @click="handleClose"
            >
                Cancel
            </BaseButton>
            <BaseButton
                v-if="activeMode"
                variant="primary"
                size="md"
                :disabled="!canImport || isImporting"
                data-testid="import-modal-import-button"
                @click="doImport()"
            >
                {{ isImporting ? 'Importing...' : 'Import' }}
            </BaseButton>
        </template>
    </BaseModal>
</template>

<script setup>
import { ref, computed, markRaw } from 'vue'
import { useDocStore } from '@/store/docStore'
import { useUiStore } from '@/store/uiStore'
import { isMarkdownFile } from '@/utils/importUtils'
import { Upload, AlertCircle, FileText, FolderOpen, Archive, Braces, Image } from 'lucide-vue-next'
import BaseModal from '@/components/BaseModal.vue'
import BaseButton from '@/components/BaseButton.vue'
import OptionCard from '@/components/OptionCard.vue'

defineProps({
    show: Boolean
})

const emit = defineEmits(['close', 'import-success'])
const docStore = useDocStore()
const uiStore = useUiStore()

// ── State ────────────────────────────────────────────────────

const activeMode = ref(null) // null | 'markdown' | 'directory' | 'zip' | 'json'
const isDragging = ref(false)
const error = ref('')
const isImporting = ref(false)

// Progress
const progressCurrent = ref(0)
const progressTotal = ref(0)
const progressPercent = computed(() =>
    progressTotal.value > 0 ? Math.round((progressCurrent.value / progressTotal.value) * 100) : 0
)

// Markdown files mode
const selectedFiles = ref([])
const mdFileInput = ref(null)

// Directory mode
const dirInput = ref(null)

// Document with linked images mode
const fileSystemAccessSupported = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
const linkedSourceDirectory = ref(null)
const linkedDocuments = ref([])
const selectedLinkedDocumentPath = ref('')

// ZIP mode
const selectedZipFile = ref(null)
const zipFileInput = ref(null)

// JSON mode
const jsonData = ref('')
const isStackEditFormat = ref(false)
const jsonFileInput = ref(null)

const modeTitles = {
    markdown: 'Import Markdown Files',
    directory: 'Import Markdown Folder',
    'document-images': 'Import Document with Linked Images',
    zip: 'Import ZIP Archive',
    json: 'Import JSON Backup',
}

// ── Computed ─────────────────────────────────────────────────

const canImport = computed(() => {
    if (isImporting.value) return false
    switch (activeMode.value) {
        case 'markdown': return selectedFiles.value.length > 0
        case 'directory': return selectedFiles.value.length > 0
        case 'document-images': return Boolean(selectedLinkedDocumentPath.value)
        case 'zip': return selectedZipFile.value !== null
        case 'json': return jsonData.value.trim().length > 0
        default: return false
    }
})

// ── Navigation ───────────────────────────────────────────────

function selectMode(mode) {
    activeMode.value = mode
    error.value = ''
}

function goBack() {
    activeMode.value = null
    error.value = ''
    resetSelections()
}

function handleClose() {
    if (isImporting.value) return
    activeMode.value = null
    error.value = ''
    resetSelections()
    emit('close')
}

function resetSelections() {
    selectedFiles.value = []
    selectedZipFile.value = null
    linkedSourceDirectory.value = null
    linkedDocuments.value = []
    selectedLinkedDocumentPath.value = ''
    jsonData.value = ''
    isStackEditFormat.value = false
    progressCurrent.value = 0
    progressTotal.value = 0
}

function onProgress(current, total) {
    progressCurrent.value = current
    progressTotal.value = total
}

// ── Markdown file handlers ───────────────────────────────────

function handleMarkdownDrop(e) {
    isDragging.value = false
    const files = Array.from(e.dataTransfer.files).filter(f => isMarkdownFile(f.name))
    if (files.length > 0) {
        selectedFiles.value = files
        error.value = ''
    } else {
        error.value = 'No .md files found in the dropped items.'
    }
}

function handleMarkdownFileSelect(e) {
    selectedFiles.value = Array.from(e.target.files)
    error.value = ''
}

// ── Directory handler ────────────────────────────────────────

function handleDirectorySelect(e) {
    selectedFiles.value = Array.from(e.target.files)
    error.value = ''
}

async function chooseDocumentSourceFolder() {
    error.value = ''

    try {
        const directoryHandle = await window.showDirectoryPicker({ mode: 'read' })
        const documents = await docStore.listMarkdownDocumentsInDirectory(directoryHandle)
        linkedSourceDirectory.value = markRaw(directoryHandle)
        linkedDocuments.value = documents.map(document => ({
            ...document,
            handle: markRaw(document.handle),
        }))
        selectedLinkedDocumentPath.value = documents.length === 1 ? documents[0].path : ''

        if (documents.length === 0) {
            error.value = 'No .md documents were found in the selected folder.'
        }
    } catch (err) {
        if (err?.name === 'AbortError') return
        error.value = `Unable to read the selected folder: ${err.message || 'Unknown error'}`
    }
}

// ── ZIP handlers ─────────────────────────────────────────────

function handleZipDrop(e) {
    isDragging.value = false
    const file = e.dataTransfer.files[0]
    if (file && file.name.toLowerCase().endsWith('.zip')) {
        selectedZipFile.value = file
        error.value = ''
    } else {
        error.value = 'Please drop a .zip file.'
    }
}

function handleZipFileSelect(e) {
    const file = e.target.files[0]
    if (file) {
        selectedZipFile.value = file
        error.value = ''
    }
}

// ── JSON handlers ────────────────────────────────────────────

function handleJsonDrop(e) {
    isDragging.value = false
    const file = e.dataTransfer.files[0]
    if (file) readJsonFile(file)
}

function handleJsonFileSelect(e) {
    const file = e.target.files[0]
    if (file) readJsonFile(file)
}

function readJsonFile(file) {
    if (file.type !== 'application/json' && !file.name.endsWith('.json')) {
        error.value = 'Please select a JSON file'
        return
    }
    const reader = new FileReader()
    reader.onload = (e) => {
        try {
            JSON.parse(e.target.result)
            jsonData.value = e.target.result
            error.value = ''
        } catch {
            error.value = 'Invalid JSON format'
        }
    }
    reader.onerror = () => { error.value = 'Error reading file' }
    reader.readAsText(file)
}

function buildImportToastMessage(result) {
    const parts = []

    if (result.created) parts.push(`${result.created} created`)
    if (result.updated) parts.push(`${result.updated} updated`)
    if (result.unchanged) parts.push(`${result.unchanged} unchanged`)
    if (result.foldersCreated) parts.push(`${result.foldersCreated} folder${result.foldersCreated !== 1 ? 's' : ''} created`)
    if (result.imagesImported) parts.push(`${result.imagesImported} image${result.imagesImported !== 1 ? 's' : ''} uploaded`)

    return parts.length ? `Import complete: ${parts.join(', ')}.` : 'Nothing changed during import.'
}

function showSkippedItemsToast(result) {
    if (!result?.skippedItems?.length) return

    const preview = result.skippedItems
        .slice(0, 3)
        .map(item => `${item.path} (${item.reason})`)
        .join('; ')
    const remaining = result.skippedItems.length - 3
    const suffix = remaining > 0 ? `; +${remaining} more` : ''

    uiStore.addToast(`Skipped ${result.skippedItems.length} item(s): ${preview}${suffix}`, 'warning', 8000)
}

function shouldReloadAfterImport(result) {
    return Boolean(result && (result.created || result.updated || result.foldersCreated))
}

// ── Import dispatcher ────────────────────────────────────────

async function doImport(importOptions = {}) {
    error.value = ''
    isImporting.value = true

    try {
        let result = null

        switch (activeMode.value) {
            case 'markdown': {
                result = await docStore.importMarkdownFiles(selectedFiles.value, null, onProgress, importOptions)
                break
            }
            case 'directory': {
                result = await docStore.importMarkdownDirectory(selectedFiles.value, onProgress, importOptions)
                break
            }
            case 'document-images': {
                const document = linkedDocuments.value.find(item => item.path === selectedLinkedDocumentPath.value)
                if (!document || !linkedSourceDirectory.value) {
                    throw new Error('Choose a source folder and a Markdown document to import.')
                }
                result = await docStore.importDocumentWithLinkedImages(
                    linkedSourceDirectory.value,
                    document,
                    onProgress,
                    importOptions
                )
                break
            }
            case 'zip': {
                result = await docStore.importZipArchive(selectedZipFile.value, onProgress, importOptions)
                break
            }
            case 'json': {
                const data = JSON.parse(jsonData.value)
                if (isStackEditFormat.value) {
                    result = await docStore.importStackEditData(data, importOptions)
                } else {
                    result = await docStore.importData(data, importOptions)
                }
                break
            }
        }

        if (result) {
            uiStore.addToast(buildImportToastMessage(result), 'success')
            showSkippedItemsToast(result)
        }

        emit('import-success')
        emit('close')
        activeMode.value = null
        resetSelections()

        if (shouldReloadAfterImport(result)) {
            window.location.reload()
        }
    } catch (err) {
        if (err?.code === 'UNSAFE_OVERWRITE') {
            const confirmed = window.confirm(`${err.message}\n\nContinue anyway?`)
            if (confirmed) {
                await doImport({ ...importOptions, allowUnsafeOverwrite: true })
            }
            return
        }

        console.error('Import failed:', err)
        error.value = 'Import failed: ' + (err.message || 'Unknown error')
    } finally {
        isImporting.value = false
    }
}
</script>
