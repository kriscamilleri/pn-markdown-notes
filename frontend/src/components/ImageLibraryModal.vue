<template>
    <BaseModal
        :show="show"
        title="Image Library"
        size="md"
        close-testid="image-library-modal-close"
        @close="$emit('close')"
    >
        <div class="space-y-5">
            <div class="flex items-center justify-between gap-3">
                <div class="pn-body">
                    <p>Images: {{ imageManager.stats.imageCount }}</p>
                    <p>Total storage: {{ formatBytes(imageManager.stats.totalImageBytes) }}</p>
                </div>
                <BaseButton
                    variant="secondary"
                    size="sm"
                    :disabled="selectedIds.length === 0 || imageManager.isLoading"
                    data-testid="image-library-insert-selected"
                    @click="insertSelected"
                >
                    <Image class="h-4 w-4" />
                    <span>Insert Selected</span>
                </BaseButton>
            </div>

            <div class="grid grid-cols-3 gap-3">
                <input
                    v-model="search"
                    type="text"
                    placeholder="Search filename"
                    class="pn-input"
                    @keyup.enter="applyFilters"
                    data-testid="image-library-search"
                />
                <select
                    v-model="sort"
                    class="pn-select"
                    @change="applyFilters"
                    data-testid="image-library-sort"
                >
                    <option value="created_desc">Newest</option>
                    <option value="created_asc">Oldest</option>
                    <option value="size_desc">Largest</option>
                    <option value="size_asc">Smallest</option>
                </select>
                <BaseButton
                    variant="secondary"
                    size="md"
                    data-testid="image-library-refresh"
                    @click="applyFilters"
                >
                    <RefreshCw class="h-4 w-4" />
                    <span>Refresh</span>
                </BaseButton>
            </div>

            <p
                v-if="imageManager.error"
                class="pn-alert pn-alert-error"
            >
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
                                    data-testid="image-library-select-all"
                                />
                            </th>
                            <th>Preview</th>
                            <th>Filename</th>
                            <th>MIME</th>
                            <th>Size</th>
                            <th>Created</th>
                            <th>Usage</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-if="imageManager.isLoading">
                            <td
                                colspan="7"
                                class="pn-table-empty"
                            >
                                Loading images...
                            </td>
                        </tr>
                        <tr v-else-if="imageManager.images.length === 0">
                            <td
                                colspan="7"
                                class="pn-table-empty"
                            >
                                No images found.
                            </td>
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
                                    :data-testid="`image-library-select-${image.id}`"
                                />
                            </td>
                            <td>
                                <img
                                    :src="imagePreviewUrl(image.imageUrl)"
                                    :alt="image.filename"
                                    class="h-10 w-10 rounded-md border border-gray-200 object-cover"
                                />
                            </td>
                            <td class="break-all">{{ image.filename }}</td>
                            <td>{{ image.mimeType }}</td>
                            <td>{{ formatBytes(image.sizeBytes) }}</td>
                            <td>{{ formatDate(image.createdAt) }}</td>
                            <td>{{ image.usageCount }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div class="flex items-center justify-between gap-3">
                <BaseButton
                    variant="secondary"
                    size="sm"
                    :disabled="cursorStack.length === 0 || imageManager.isLoading"
                    data-testid="image-library-prev"
                    @click="goPrevious"
                >
                    <ChevronLeft class="h-4 w-4" />
                    <span>Previous</span>
                </BaseButton>
                <BaseButton
                    variant="secondary"
                    size="sm"
                    :disabled="!imageManager.nextCursor || imageManager.isLoading"
                    data-testid="image-library-next"
                    @click="goNext"
                >
                    <span>Next</span>
                    <ChevronRight class="h-4 w-4" />
                </BaseButton>
            </div>
        </div>

        <template #footer>
            <BaseButton
                variant="secondary"
                size="md"
                data-testid="image-library-cancel"
                @click="$emit('close')"
            >
                Cancel
            </BaseButton>
            <BaseButton
                variant="primary"
                size="md"
                :disabled="selectedIds.length === 0 || imageManager.isLoading"
                data-testid="image-library-insert-footer"
                @click="insertSelected"
            >
                Insert Selected
            </BaseButton>
        </template>
    </BaseModal>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { ChevronLeft, ChevronRight, Image, RefreshCw } from 'lucide-vue-next';
import BaseModal from '@/components/BaseModal.vue';
import BaseButton from '@/components/BaseButton.vue';
import { useImageManagerStore } from '@/store/imageManagerStore';
import { useAuthStore } from '@/store/authStore';
import { withImageAuthToken } from '@/utils/imageUrl';

const PAGE_LIMIT = 25;

const props = defineProps({
    show: Boolean,
    dbKey: {
        type: String,
        required: true,
    },
});

const emit = defineEmits(['close', 'insert-selected']);

const imageManager = useImageManagerStore();
const authStore = useAuthStore();

const search = ref('');
const sort = ref('created_desc');
const currentCursor = ref(null);
const cursorStack = ref([]);
const selectedSet = ref(new Set());

const selectedIds = computed(() => [...selectedSet.value]);
const selectedImages = computed(() => {
    const selectedIdSet = new Set(selectedIds.value);
    return imageManager.images.filter((image) => selectedIdSet.has(image.id));
});
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
    await imageManager.fetchImages(props.dbKey, {
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
        imageManager.fetchStats(props.dbKey),
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

function insertSelected() {
    if (selectedImages.value.length === 0) return;
    emit('insert-selected', selectedImages.value);
}

watch(
    () => [props.show, props.dbKey],
    async ([show]) => {
        if (!show) return;
        selectedSet.value = new Set();
        await applyFilters();
    }
);
</script>
