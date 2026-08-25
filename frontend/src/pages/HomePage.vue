<template>
    <div class="h-screen flex flex-col overflow-hidden">
        <Navbar />
        <SubMenuBar />
        <div ref="mainContent" class="flex flex-1 overflow-hidden" data-testid="homepage-main-content">
            <SidebarWithResizer :isMobileView="isMobileView" />
            <ContentArea :isMobileView="isMobileView" />
        </div>
        <ImportModal :show="ui.showImportModal" @close="ui.closeImportModal()" @import-success="handleImportSuccess"
            data-testid="homepage-import-modal" />
        <ExportModal :show="ui.showExportModal" @close="ui.closeExportModal()" data-testid="homepage-export-modal" />
        <GitHubBackupModal :show="ui.showGithubBackupModal" @close="ui.closeGithubBackupModal()" data-testid="homepage-github-backup-modal" />
        <VariablesModal :show="ui.showVariablesModal" @close="ui.closeVariablesModal()" data-testid="homepage-variables-modal" />
        <ImageLibraryModal
            :show="ui.showImageLibraryModal"
            :db-key="docStore.selectedDbKey"
            @close="ui.closeImageLibraryModal()"
            @insert-selected="handleInsertSelectedImages"
            data-testid="homepage-image-library-modal"
        />
    </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import Navbar from '@/components/Navbar.vue'
import SubMenuBar from '@/components/SubMenuBar.vue'
import SidebarWithResizer from '@/components/SidebarWithResizer.vue'
import ContentArea from '@/components/ContentArea.vue'
import ImportModal from '@/components/ImportModal.vue'
import ExportModal from '@/components/ExportModal.vue'
import GitHubBackupModal from '@/components/GitHubBackupModal.vue'
import VariablesModal from '@/components/VariablesModal.vue'
import ImageLibraryModal from '@/components/ImageLibraryModal.vue'
import { useUiStore } from '@/store/uiStore'
import { useDocStore } from '@/store/docStore'
import { useEditorStore } from '@/store/editorStore'
import { useGlobalVariablesStore } from '@/store/globalVariablesStore'
import { useRouter } from 'vue-router'

const ui = useUiStore()
const docStore = useDocStore()
const editorStore = useEditorStore()
const globalVariablesStore = useGlobalVariablesStore()
const route = useRoute()
const router = useRouter()

// Mobile view detection
const windowWidth = ref(window.innerWidth)
const isMobileView = computed(() => windowWidth.value < 768)
const handleResize = () => { windowWidth.value = window.innerWidth }
onMounted(() => window.addEventListener('resize', handleResize))
onUnmounted(() => window.removeEventListener('resize', handleResize))

// Sync store on route param changes
async function applyRouteSelection() {
    const dbKey = typeof route.query.dbKey === 'string'
        ? route.query.dbKey
        : docStore.syncStore.personalDbKey
    if (route.params.fileId) {
        await docStore.selectFile(route.params.fileId, dbKey)
        // Auto-collapse Documents pane on mobile when a document is selected
        ui.collapseDocumentsOnMobile(isMobileView.value)
    } else if (route.params.folderId) {
        docStore.selectFolder(route.params.folderId, dbKey)
    } else {
        docStore.selectFolder(null, docStore.syncStore.personalDbKey)
    }
    await globalVariablesStore.loadGlobals(dbKey)
}
onMounted(applyRouteSelection)
watch(() => route.params.fileId, applyRouteSelection)
watch(() => route.params.folderId, applyRouteSelection)
watch(() => route.query.dbKey, applyRouteSelection)

function handleImportSuccess() {
    console.info('Import successful')
    ui.addToast('Data imported successfully!', 'success');
    docStore.loadInitialData();
}

function handleInsertSelectedImages(images) {
    editorStore.insertImageFromLibrary(images)
    ui.closeImageLibraryModal()
}

watch(() => route.query.githubBackup, async (value) => {
    if (!value) {
        return;
    }

    ui.openGithubBackupModal();
    if (value === 'connected') {
        ui.addToast('GitHub backup connected.', 'success');
    } else if (value === 'error') {
        const message = String(route.query.message || 'GitHub backup connection failed.');
        ui.addToast(message, 'error');
    }

    const nextQuery = { ...route.query };
    delete nextQuery.githubBackup;
    delete nextQuery.message;
    await router.replace({ query: nextQuery });
}, { immediate: true });
</script>
