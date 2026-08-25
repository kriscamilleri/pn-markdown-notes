<template>
    <AccountLayout title="Images" max-width-class="max-w-7xl">
        <div class="space-y-6">
            <label class="block max-w-md">
                <span class="pn-label">Image library</span>
                <select
                    v-model="selectedDbKey"
                    class="pn-select mt-1 w-full"
                    data-testid="images-database-scope"
                    @change="handleScopeChange"
                >
                    <option v-for="scope in availableScopes" :key="scope.dbKey" :value="scope.dbKey">
                        {{ scope.label }}
                    </option>
                </select>
            </label>

            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div class="pn-body">
                    <p>Images: {{ imageManager.stats.imageCount }}</p>
                    <p>Total storage: {{ formatBytes(imageManager.stats.totalImageBytes) }}</p>
                </div>
                <BaseButton
                    variant="danger"
                    size="md"
                    :disabled="selectedIds.length === 0 || imageManager.isDeleting"
                    @click="handleBulkDelete"
                    data-testid="images-bulk-delete"
                >
                    <Trash2 class="w-4 h-4" />
                    <span>Delete Selected</span>
                </BaseButton>
            </div>

            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <input
                    v-model="search"
                    type="text"
                    placeholder="Search filename"
                    class="pn-input"
                    @keyup.enter="applyFilters"
                    data-testid="images-search"
                />
                <select
                    v-model="sort"
                    class="pn-select"
                    @change="applyFilters"
                    data-testid="images-sort"
                >
                    <option value="created_desc">Newest</option>
                    <option value="created_asc">Oldest</option>
                    <option value="size_desc">Largest</option>
                    <option value="size_asc">Smallest</option>
                </select>
                <BaseButton
                    variant="secondary"
                    size="md"
                    @click="applyFilters"
                    data-testid="images-refresh"
                >
                    <RefreshCw class="w-4 h-4" />
                    <span>Refresh</span>
                </BaseButton>
            </div>

            <p v-if="imageManager.error" class="pn-alert pn-alert-error">
                {{ imageManager.error }}
            </p>

            <div class="pn-table-wrap">
                <table class="pn-table">
                    <thead>
                        <tr>
                            <th>
                                <input
                                    type="checkbox"
                                    class="pn-checkbox"
                                    :checked="allSelected"
                                    @change="toggleAll"
                                    data-testid="images-select-all"
                                />
                            </th>
                            <th>Preview</th>
                            <th>Filename</th>
                            <th>MIME</th>
                            <th>Size</th>
                            <th>Created</th>
                            <th>Usage</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-if="imageManager.isLoading">
                            <td colspan="8" class="pn-table-empty">Loading images...</td>
                        </tr>
                        <tr v-else-if="imageManager.images.length === 0">
                            <td colspan="8" class="pn-table-empty">No images found.</td>
                        </tr>
                        <tr
                            v-else
                            v-for="image in imageManager.images"
                            :key="image.id"
                        >
                            <td>
                                <input
                                    type="checkbox"
                                    class="pn-checkbox"
                                    :checked="selectedSet.has(image.id)"
                                    @change="toggleSelected(image.id)"
                                    :data-testid="`images-select-${image.id}`"
                                />
                            </td>
                            <td>
                                <img
                                    :src="imagePreviewUrl(image.imageUrl)"
                                    :alt="image.filename"
                                    class="h-10 w-10 rounded-md border border-gray-200 object-cover"
                                />
                            </td>
                            <td>{{ image.filename }}</td>
                            <td>{{ image.mimeType }}</td>
                            <td>{{ formatBytes(image.sizeBytes) }}</td>
                            <td>{{ formatDate(image.createdAt) }}</td>
                            <td>{{ image.usageCount }}</td>
                            <td>
                                <BaseButton
                                    variant="danger"
                                    :disabled="imageManager.isDeleting"
                                    @click="handleSingleDelete(image)"
                                    :data-testid="`images-delete-${image.id}`"
                                >
                                    <Trash2 class="w-4 h-4" />
                                    <span>Delete</span>
                                </BaseButton>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div class="flex items-center justify-between">
                <BaseButton
                    variant="secondary"
                    :disabled="cursorStack.length === 0 || imageManager.isLoading"
                    @click="goPrevious"
                    data-testid="images-prev"
                >
                    <ChevronLeft class="w-4 h-4" />
                    <span>Previous</span>
                </BaseButton>
                <BaseButton
                    variant="secondary"
                    :disabled="!imageManager.nextCursor || imageManager.isLoading"
                    @click="goNext"
                    data-testid="images-next"
                >
                    <span>Next</span>
                    <ChevronRight class="w-4 h-4" />
                </BaseButton>
            </div>
        </div>
    </AccountLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { ChevronLeft, ChevronRight, RefreshCw, Trash2 } from 'lucide-vue-next';
import AccountLayout from '@/components/AccountLayout.vue';
import BaseButton from '@/components/BaseButton.vue';
import { useImageManagerStore } from '@/store/imageManagerStore';
import { useSyncStore } from '@/store/syncStore';
import { useAuthStore } from '@/store/authStore';
import { useUiStore } from '@/store/uiStore';
import { useRoute, useRouter } from 'vue-router';
import { withImageAuthToken } from '@/utils/imageUrl';

const PAGE_LIMIT = 25;

const imageManager = useImageManagerStore();
const syncStore = useSyncStore();
const authStore = useAuthStore();
const uiStore = useUiStore();
const route = useRoute();
const router = useRouter();

const search = ref('');
const sort = ref('created_desc');
const currentCursor = ref(null);
const cursorStack = ref([]);
const selectedSet = ref(new Set());
const selectedDbKey = ref(typeof route.query.dbKey === 'string' ? route.query.dbKey : syncStore.personalDbKey);

const availableScopes = computed(() => [...syncStore.databases.values()]
    .filter((entry) => entry.db)
    .map((entry) => ({
        dbKey: entry.dbKey,
        label: entry.kind === 'space' ? entry.name : 'Personal Documents',
    })));

const selectedIds = computed(() => [...selectedSet.value]);
const allSelected = computed(() => {
    if (imageManager.images.length === 0) return false;
    return imageManager.images.every((image) => selectedSet.value.has(image.id));
});

function formatDate(value) {
    if (!value) return 'Unknown';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
}

function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value < 1024) return `${Math.max(0, value)} B`;
    const units = ['KB', 'MB', 'GB'];
    let result = value;
    let index = -1;
    while (result >= 1024 && index < units.length - 1) {
        result /= 1024;
        index += 1;
    }
    return `${result.toFixed(result >= 10 ? 1 : 2)} ${units[index]}`;
}

function imagePreviewUrl(url) {
    return withImageAuthToken(url, authStore.token, {
        origin: window.location.origin,
        absolute: !import.meta.env.PROD,
    });
}

async function loadPage(cursor = null) {
    await imageManager.fetchImages(selectedDbKey.value, {
        limit: PAGE_LIMIT,
        cursor,
        search: search.value.trim(),
        sort: sort.value,
    });

    selectedSet.value = new Set(
        selectedIds.value.filter((id) => imageManager.images.some((image) => image.id === id))
    );
    currentCursor.value = cursor;
}

async function applyFilters() {
    cursorStack.value = [];
    currentCursor.value = null;
    await Promise.all([
        loadPage(null),
        imageManager.fetchStats(selectedDbKey.value),
    ]);
}

async function goNext() {
    if (!imageManager.nextCursor) return;
    cursorStack.value.push(currentCursor.value);
    await loadPage(imageManager.nextCursor);
}

async function goPrevious() {
    if (cursorStack.value.length === 0) return;
    const previousCursor = cursorStack.value.pop();
    await loadPage(previousCursor || null);
}

function toggleSelected(imageId) {
    const next = new Set(selectedSet.value);
    if (next.has(imageId)) {
        next.delete(imageId);
    } else {
        next.add(imageId);
    }
    selectedSet.value = next;
}

function toggleAll() {
    if (allSelected.value) {
        selectedSet.value = new Set();
        return;
    }
    selectedSet.value = new Set(imageManager.images.map((image) => image.id));
}

function summarizeUsage(usageMap) {
    const referenced = Object.values(usageMap).filter((usage) => usage.count > 0);
    if (referenced.length === 0) {
        return 'No documents reference the selected images. This is a safe delete.';
    }

    const totalReferences = referenced.reduce((acc, usage) => acc + usage.count, 0);
    const notes = [];
    referenced.forEach((usage) => {
        usage.notes.forEach((note) => {
            if (notes.length < 5 && !notes.some((existing) => existing.id === note.id)) {
                notes.push(note);
            }
        });
    });

    const noteList = notes.map((note) => `- ${note.title}`).join('\n');
    return `Warning: ${totalReferences} document reference(s) found. Markdown links will break if deleted.\n\nAffected documents (up to 5):\n${noteList}`;
}

async function collectUsage(imageIds) {
    const usageMap = {};
    for (const imageId of imageIds) {
        usageMap[imageId] = await imageManager.fetchImageUsage(selectedDbKey.value, imageId);
    }
    return usageMap;
}

async function refreshAfterDelete(deletedIds) {
    if (deletedIds.length > 0) {
        selectedSet.value = new Set(selectedIds.value.filter((id) => !deletedIds.includes(id)));
    }

    await Promise.all([
        loadPage(currentCursor.value),
        imageManager.fetchStats(selectedDbKey.value),
    ]);
}

async function handleSingleDelete(image) {
    const usage = await imageManager.fetchImageUsage(selectedDbKey.value, image.id);
    const warning = summarizeUsage({ [image.id]: usage });
    const confirmed = window.confirm(`Delete image "${image.filename}"?\n\n${warning}`);
    if (!confirmed) return;

    try {
        await imageManager.deleteImage(selectedDbKey.value, image.id, usage.count > 0);
        uiStore.addToast('Image deleted.', 'success');
        await refreshAfterDelete([image.id]);
    } catch (err) {
        uiStore.addToast(err.message || 'Failed to delete image.', 'error');
    }
}

async function handleBulkDelete() {
    const ids = selectedIds.value;
    if (ids.length === 0) return;

    const usageMap = await collectUsage(ids);
    const warning = summarizeUsage(usageMap);
    const confirmed = window.confirm(`Delete ${ids.length} selected image(s)?\n\n${warning}`);
    if (!confirmed) return;

    try {
        const force = Object.values(usageMap).some((usage) => usage.count > 0);
        const response = await imageManager.bulkDelete(selectedDbKey.value, ids, force);
        const results = response?.results || [];
        const deletedIds = results.filter((result) => result.deleted).map((result) => result.id);
        const failed = results.filter((result) => !result.deleted).length;

        if (deletedIds.length > 0) {
            uiStore.addToast(`Deleted ${deletedIds.length} image(s).`, 'success');
        }
        if (failed > 0) {
            uiStore.addToast(`${failed} image(s) were not deleted.`, 'warning');
        }

        await refreshAfterDelete(deletedIds);
    } catch (err) {
        uiStore.addToast(err.message || 'Bulk delete failed.', 'error');
    }
}

async function handleScopeChange() {
    selectedSet.value = new Set();
    cursorStack.value = [];
    currentCursor.value = null;
    const query = { ...route.query };
    if (selectedDbKey.value === syncStore.personalDbKey) delete query.dbKey;
    else query.dbKey = selectedDbKey.value;
    await router.replace({ query });
    await applyFilters();
}

onMounted(async () => {
    if (!availableScopes.value.some((scope) => scope.dbKey === selectedDbKey.value)) {
        selectedDbKey.value = syncStore.personalDbKey;
    }
    await applyFilters();
});
</script>
