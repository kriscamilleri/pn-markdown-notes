<template>
    <BaseModal
        :show="show"
        title="GitHub Backup"
        size="lg"
        close-testid="github-backup-modal-close"
        @close="emit('close')"
    >
        <div class="space-y-5">
            <p class="pn-body">
                Push a full snapshot of your documents, folders, and images to a private GitHub repository.
            </p>

            <div
                class="pn-alert pn-alert-info"
                data-testid="github-backup-personal-only"
            >
                GitHub Backup includes only your personal Documents, folders, and images. Shared spaces are excluded and are protected separately by the server's disaster-recovery backups.
            </div>

            <div
                v-if="store.error"
                class="pn-alert pn-alert-error"
                data-testid="github-backup-modal-store-error"
            >
                {{ store.error }}
            </div>

            <section class="pn-panel p-4">
                <div class="flex items-center justify-between gap-4">
                    <div>
                        <h4 class="pn-title-section">Connection</h4>
                        <p class="mt-1 pn-body">
                            Authenticate with GitHub once. Panino stores the token on the backend and performs all backup API calls server-side.
                        </p>
                    </div>

                    <BaseButton
                        v-if="!store.status?.connected"
                        variant="primary"
                        size="md"
                        class="shrink-0"
                        :disabled="!store.status?.oauthConfigured || store.isLoadingStatus"
                        data-testid="github-backup-connect-button"
                        @click="handleConnect"
                    >
                        <Github class="h-4 w-4" />
                        <span>Connect GitHub</span>
                    </BaseButton>

                    <BaseButton
                        v-else
                        variant="secondary"
                        size="md"
                        class="shrink-0"
                        :disabled="store.isDisconnecting || store.status?.isRunning"
                        data-testid="github-backup-disconnect-button"
                        @click="handleDisconnect"
                    >
                        <Unplug class="h-4 w-4" />
                        <span>{{ store.isDisconnecting ? 'Disconnecting...' : 'Disconnect' }}</span>
                    </BaseButton>
                </div>

                <div
                    v-if="!store.status?.oauthConfigured"
                    class="pn-alert pn-alert-warning mt-4"
                >
                    <span>
                        GitHub OAuth is not configured on this server. Set <strong>GITHUB_CLIENT_ID</strong> and <strong>GITHUB_CLIENT_SECRET</strong> first.
                    </span>
                </div>

                <div
                    v-else-if="store.status?.connected"
                    class="pn-alert pn-alert-success mt-4 items-center gap-4"
                    data-testid="github-backup-connected-state"
                >
                    <img
                        v-if="store.status?.avatarUrl"
                        :src="store.status.avatarUrl"
                        alt="GitHub avatar"
                        class="h-12 w-12 rounded-full border border-emerald-200 object-cover"
                    />
                    <div>
                        <p class="font-medium text-emerald-900">Connected as {{ store.status.username }}</p>
                        <p>
                            {{ store.status?.repoFullName ? 'Daily backups are enabled.' : 'Daily backups are enabled once a repository is selected.' }}
                        </p>
                    </div>
                </div>
            </section>

            <section
                v-if="!store.selectedRepoFullName || isChangingRepo"
                class="pn-panel p-4"
            >
                <div class="flex items-start justify-between gap-4">
                    <div>
                        <h4 class="pn-title-section">Repository</h4>
                        <p class="mt-1 pn-body">
                            Choose an existing repository with push access or create a new private one.
                        </p>
                    </div>
                    <BaseButton
                        v-if="isChangingRepo"
                        variant="secondary"
                        size="md"
                        class="shrink-0"
                        :disabled="!store.isConnected || store.isLoadingRepos"
                        data-testid="github-backup-refresh-repos"
                        @click="refreshRepos"
                    >
                        {{ store.isLoadingRepos ? 'Refreshing...' : 'Refresh' }}
                    </BaseButton>
                </div>

                <!-- Repo picker -->
                <div class="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                    <div>
                        <label
                            class="pn-label"
                            for="github-backup-repo-select"
                        >Select repository</label>
                        <select
                            id="github-backup-repo-select"
                            v-model="selectedRepo"
                            :disabled="!store.isConnected || store.isLoadingRepos || store.isSavingRepo"
                            class="pn-select"
                            data-testid="github-backup-repo-select"
                        >
                            <option value="">Choose a repository...</option>
                            <option
                                v-for="repo in store.repos"
                                :key="repo.fullName"
                                :value="repo.fullName"
                            >
                                {{ repo.fullName }}
                            </option>
                        </select>
                    </div>

                    <BaseButton
                        variant="primary"
                        size="md"
                        :disabled="!selectedRepo || selectedRepo === store.selectedRepoFullName || store.isSavingRepo"
                        data-testid="github-backup-save-repo"
                        @click="handleSelectRepo"
                    >
                        {{ store.isSavingRepo ? 'Saving...' : 'Use Repository' }}
                    </BaseButton>
                </div>

                <div class="pn-panel-muted mt-4 p-4">
                    <p class="pn-title-sub">Create a new private repository</p>
                    <div class="mt-3 flex flex-col gap-3 sm:flex-row">
                        <input
                            v-model.trim="newRepoName"
                            type="text"
                            placeholder="panino-backup"
                            :disabled="!store.isConnected || store.isCreatingRepo"
                            class="pn-input min-w-0 flex-1"
                            data-testid="github-backup-create-input"
                        />
                        <BaseButton
                            variant="secondary"
                            size="md"
                            class="shrink-0"
                            :disabled="!newRepoName || !store.isConnected || store.isCreatingRepo"
                            data-testid="github-backup-create-button"
                            @click="handleCreateRepo"
                        >
                            {{ store.isCreatingRepo ? 'Creating...' : 'Create Private Repo' }}
                        </BaseButton>
                    </div>
                </div>
            </section>

            <section class="pn-panel p-4">
                <div>
                    <h4 class="pn-title-section">Backup</h4>
                    <p class="mt-1 pn-body">
                        Create a full snapshot commit on <span class="font-medium text-gray-900">main</span>. Each backup preserves the repository's commit history.
                    </p>
                </div>

                <div
                    v-if="showProgressPanel"
                    class="pn-panel-muted mt-4 p-4"
                    data-testid="github-backup-progress"
                >
                    <p class="pn-title-sub">{{ currentStageLabel }}</p>
                    <div class="mt-3 grid gap-2 sm:grid-cols-4">
                        <div
                            v-for="step in progressSteps"
                            :key="step.key"
                            class="rounded-md border px-3 py-2 text-xs font-medium"
                            :class="step.stateClass"
                        >
                            {{ step.label }}
                        </div>
                    </div>
                </div>

                <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                    <div class="pn-panel-muted min-w-0 px-4 py-3">
                        <dt class="pn-meta">Repository</dt>
                        <dd class="mt-1 truncate font-medium">
                            <a
                                v-if="store.status?.repoFullName"
                                :href="repoGithubUrl(store.status.repoFullName)"
                                target="_blank"
                                rel="noopener noreferrer"
                                :title="store.status.repoFullName"
                                class="text-blue-600 hover:underline"
                            >{{ store.status.repoFullName }}</a>
                            <span
                                v-else
                                class="text-gray-900"
                            >Not selected</span>
                        </dd>
                    </div>
                    <div class="pn-panel-muted min-w-0 px-4 py-3">
                        <dt class="pn-meta">Next scheduled backup</dt>
                        <dd class="mt-1 font-medium text-gray-900">{{ formatDate(store.status?.nextScheduledAt) }}</dd>
                    </div>
                    <div class="pn-panel-muted min-w-0 px-4 py-3">
                        <dt class="pn-meta">Last backup</dt>
                        <dd class="mt-1 font-medium text-gray-900">{{ formatDate(store.status?.lastBackupAt) }}</dd>
                    </div>
                    <div class="pn-panel-muted min-w-0 px-4 py-3">
                        <dt class="pn-meta">Commit</dt>
                        <dd class="mt-1 truncate font-mono text-xs">
                            <a
                                v-if="store.status?.lastBackupSha && store.status?.repoFullName"
                                :href="commitGithubUrl(store.status.repoFullName, store.status.lastBackupSha)"
                                target="_blank"
                                rel="noopener noreferrer"
                                :title="store.status.lastBackupSha"
                                class="text-blue-600 hover:underline"
                            >{{ store.status.lastBackupSha.slice(0, 12) }}</a>
                            <span
                                v-else
                                class="text-gray-900"
                            >{{ store.status?.lastBackupSha || 'Unavailable' }}</span>
                        </dd>
                    </div>
                </dl>

                <div class="mt-4 flex items-center gap-3">
                    <BaseButton
                        variant="primary"
                        size="md"
                        :disabled="!canRunBackup"
                        data-testid="github-backup-run-button"
                        @click="handleRunBackup"
                    >
                        <CloudUpload class="h-4 w-4" />
                        <span>{{ store.status?.isRunning ? 'Backup Running...' : 'Back Up Now' }}</span>
                    </BaseButton>
                    <BaseButton
                        v-if="store.selectedRepoFullName"
                        variant="secondary"
                        size="md"
                        :disabled="!store.isConnected || store.isLoadingRepos"
                        data-testid="github-backup-change-repo"
                        @click="startChangingRepo"
                    >
                        Change Repository
                    </BaseButton>
                </div>

                <div
                    v-if="store.status?.lastWarning"
                    class="pn-alert pn-alert-warning mt-4"
                    data-testid="github-backup-last-warning"
                >
                    Last backup completed with warnings: {{ store.status.lastWarning }}
                </div>

                <div
                    v-if="store.status?.lastError"
                    class="pn-alert pn-alert-error mt-4"
                    data-testid="github-backup-last-error"
                >
                    Last backup failed: {{ store.status.lastError }}
                </div>
            </section>
        </div>

        <template #footer>
            <BaseButton
                variant="secondary"
                size="md"
                @click="emit('close')"
            >
                Done
            </BaseButton>
        </template>
    </BaseModal>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { CloudUpload, Github, Unplug } from 'lucide-vue-next';
import { useGithubBackupStore } from '@/store/githubBackupStore';
import { useUiStore } from '@/store/uiStore';
import BaseModal from '@/components/BaseModal.vue';
import BaseButton from '@/components/BaseButton.vue';
import {
    buildBackupProgressSteps,
    getBackupStageLabel,
    resolveVisibleBackupStage,
} from '@/utils/githubBackupProgress';

const props = defineProps({
    show: Boolean,
});

const emit = defineEmits(['close']);
const store = useGithubBackupStore();
const uiStore = useUiStore();
const { status } = storeToRefs(store);
const selectedRepo = ref('');
const newRepoName = ref('panino-backup');
const isChangingRepo = ref(false);
const retainedStage = ref(null);
const isShowingCompletion = ref(false);
let pollHandle = null;
let pollInFlight = false;
let progressHideHandle = null;

const POLL_INTERVAL_MS = 250;
const COMPLETION_LINGER_MS = 1800;

const canRunBackup = computed(() => {
    return Boolean(
        store.status?.connected &&
        store.status?.repoFullName &&
        !store.status?.isRunning &&
        !store.isStartingBackup
    );
});

const visibleStage = computed(() => resolveVisibleBackupStage({
    status: status.value,
    retainedStage: retainedStage.value,
    isShowingCompletion: isShowingCompletion.value,
}));

const showProgressPanel = computed(() => Boolean(visibleStage.value));

const currentStageLabel = computed(() => {
    return getBackupStageLabel(visibleStage.value || 'queued');
});

const progressSteps = computed(() => {
    return buildBackupProgressSteps(visibleStage.value || 'queued');
});

function formatDate(value) {
    if (!value) {
        return 'Not yet';
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return 'Unknown';
    }

    return parsed.toLocaleString();
}

async function loadModalData() {
    try {
        const currentStatus = await store.fetchStatus();
        selectedRepo.value = currentStatus?.repoFullName || '';
        isChangingRepo.value = !currentStatus?.repoFullName;
        retainedStage.value = currentStatus?.isRunning ? (currentStatus.currentStage || 'queued') : null;
        isShowingCompletion.value = false;
        if (currentStatus?.connected) {
            await store.fetchRepos();
        }
        syncPolling(0);
    } catch {
        stopPolling();
    }
}

function repoGithubUrl(repoFullName) {
    if (!repoFullName) return null;
    return `https://github.com/${repoFullName}`;
}

function commitGithubUrl(repoFullName, sha) {
    if (!repoFullName || !sha) return null;
    return `https://github.com/${repoFullName}/commit/${sha}`;
}

function clearCompletionTimer() {
    if (progressHideHandle) {
        clearTimeout(progressHideHandle);
        progressHideHandle = null;
    }
}

function stopPolling() {
    if (pollHandle) {
        clearTimeout(pollHandle);
        pollHandle = null;
    }
}

function keepProgressVisible(stage) {
    clearCompletionTimer();
    retainedStage.value = stage || retainedStage.value || 'pushing_to_github';
    isShowingCompletion.value = true;
    progressHideHandle = setTimeout(() => {
        isShowingCompletion.value = false;
        if (!status.value?.isRunning) {
            retainedStage.value = null;
        }
        progressHideHandle = null;
    }, COMPLETION_LINGER_MS);
}

function syncPolling(delay = POLL_INTERVAL_MS) {
    if (!props.show || !status.value?.isRunning) {
        stopPolling();
        return;
    }

    if (!pollHandle) {
        pollHandle = setTimeout(async () => {
            pollHandle = null;

            if (pollInFlight) {
                syncPolling();
                return;
            }

            pollInFlight = true;
            try {
                const refreshedStatus = await store.fetchStatus();
                selectedRepo.value = refreshedStatus?.repoFullName || selectedRepo.value;
                if (refreshedStatus?.isRunning) {
                    retainedStage.value = refreshedStatus.currentStage || retainedStage.value || 'queued';
                    syncPolling();
                } else {
                    stopPolling();
                }
            } catch {
                stopPolling();
            } finally {
                pollInFlight = false;
            }
        }, delay);
    }
}

async function handleConnect() {
    try {
        const authorizeUrl = await store.startConnect();
        if (authorizeUrl) {
            window.location.assign(authorizeUrl);
        }
    } catch (err) {
        uiStore.addToast(err.message || 'Failed to start GitHub OAuth', 'error');
    }
}

async function handleDisconnect() {
    try {
        await store.disconnect();
        selectedRepo.value = '';
        uiStore.addToast('GitHub backup disconnected.', 'success');
    } catch (err) {
        uiStore.addToast(err.message || 'Failed to disconnect GitHub backup', 'error');
    }
}

async function refreshRepos() {
    try {
        await store.fetchRepos();
        uiStore.addToast('GitHub repositories refreshed.', 'success');
    } catch (err) {
        uiStore.addToast(err.message || 'Failed to refresh repositories', 'error');
    }
}

async function handleSelectRepo() {
    try {
        await store.selectRepo(selectedRepo.value);
        isChangingRepo.value = false;
        uiStore.addToast('Backup repository updated.', 'success');
    } catch (err) {
        uiStore.addToast(err.message || 'Failed to save repository selection', 'error');
    }
}

async function handleCreateRepo() {
    try {
        const repo = await store.createRepo(newRepoName.value);
        selectedRepo.value = repo?.fullName || selectedRepo.value;
        isChangingRepo.value = false;
        uiStore.addToast('Private GitHub repository created.', 'success');
    } catch (err) {
        uiStore.addToast(err.message || 'Failed to create repository', 'error');
    }
}

function startChangingRepo() {
    selectedRepo.value = '';
    isChangingRepo.value = true;
}

async function handleRunBackup() {
    try {
        await store.runBackup();
        retainedStage.value = status.value?.currentStage || 'queued';
        isShowingCompletion.value = false;
        clearCompletionTimer();
        syncPolling(0);
        uiStore.addToast('GitHub backup started.', 'info');
    } catch (err) {
        uiStore.addToast(err.message || 'Failed to start backup', 'error');
    }
}

watch(() => props.show, (isOpen) => {
    if (isOpen) {
        loadModalData();
    } else {
        stopPolling();
        clearCompletionTimer();
        isShowingCompletion.value = false;
        retainedStage.value = null;
    }
}, { immediate: true });

watch(() => status.value?.currentStage, (stage) => {
    if (stage) {
        retainedStage.value = stage;
    }
});

watch(() => status.value?.isRunning, (isRunning, wasRunning) => {
    if (isRunning) {
        isShowingCompletion.value = false;
        clearCompletionTimer();
        syncPolling(0);
        return;
    }

    stopPolling();
    if (wasRunning) {
        keepProgressVisible(retainedStage.value || 'pushing_to_github');
    }
});

onBeforeUnmount(() => {
    stopPolling();
    clearCompletionTimer();
});
</script>
