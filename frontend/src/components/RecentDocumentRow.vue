<!-- frontend/src/components/RecentDocumentRow.vue -->
<template>
    <li>
        <!--
            Flat, border-separated row rather than a card. Below `sm` the
            metadata moves under the excerpt (see the two metadata blocks) while
            the pin control stays pinned to the row's top-right.
        -->
        <div
            class="flex cursor-pointer items-start gap-3 rounded-md px-2 py-3 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 focus-visible:ring-inset"
            role="button"
            tabindex="0"
            :aria-label="`Open ${document.name}`"
            :data-testid="`document-row-${document.id}`"
            @click="$emit('open', document)"
            @keydown.enter.prevent="$emit('open', document)"
            @keydown.space.prevent="$emit('open', document)"
        >
            <FileText
                class="mt-0.5 h-4 w-4 shrink-0 text-gray-400"
                aria-hidden="true"
            />

            <div class="min-w-0 flex-1">
                <span
                    class="block truncate font-medium text-blue-600"
                    :title="document.name"
                    :data-testid="`document-row-title-${document.id}`"
                >
                    {{ document.name }}
                    <span
                        v-if="hasConflict"
                        class="ml-1 inline-block h-2 w-2 rounded-full bg-amber-500 align-middle"
                        :aria-label="'Unresolved changes'"
                        :data-testid="`document-row-conflict-${document.id}`"
                    ></span>
                </span>

                <span
                    v-if="document.spaceName"
                    class="mt-0.5 block pn-meta"
                    :data-testid="`document-row-space-${document.id}`"
                >Shared in {{ document.spaceName }}</span>

                <span
                    class="block truncate pn-meta"
                    :title="document.folderName"
                    :data-testid="`document-row-folder-${document.id}`"
                >
                    {{ document.folderName }}
                </span>

                <p
                    v-if="document.excerpt"
                    class="mt-1 line-clamp-2 pn-body"
                    :data-testid="`document-row-excerpt-${document.id}`"
                >
                    {{ document.excerpt }}
                </p>

                <!-- Mobile: metadata sits beneath the excerpt. -->
                <div
                    class="mt-1 pn-meta sm:hidden"
                    :title="absoluteDate"
                    :data-testid="`document-row-meta-mobile-${document.id}`"
                >
                    {{ wordCountLabel }} · Edited {{ relativeDate }}
                </div>
            </div>

            <!-- Desktop: metadata is its own right-aligned, non-wrapping column. -->
            <div
                class="hidden shrink-0 flex-col items-end whitespace-nowrap pn-meta sm:flex"
                :title="absoluteDate"
                :data-testid="`document-row-meta-${document.id}`"
            >
                <span>{{ wordCountLabel }}</span>
                <span>Edited {{ relativeDate }}</span>
            </div>

            <DocumentPinButton
                :document-id="document.id"
                :document-name="document.name"
                :is-pinned="document.isPinned"
                @toggle="$emit('toggle-pin', document)"
            />
        </div>
    </li>
</template>

<script setup>
import { computed } from 'vue'
import { FileText } from 'lucide-vue-next'
import DocumentPinButton from '@/components/DocumentPinButton.vue'
import { useConflictStore } from '@/store/conflictStore'
import { formatAbsoluteTime, formatRelativeTime, formatWordCount } from '@/utils/recentDocuments.js'

const props = defineProps({
    document: { type: Object, required: true },
    /** Injectable clock so the rendered label is deterministic under test. */
    now: { type: Number, default: () => Date.now() },
})

defineEmits(['open', 'toggle-pin'])

const conflictStore = useConflictStore()
const hasConflict = computed(() => conflictStore.hasConflict(props.document.id, props.document.dbKey))

const wordCountLabel = computed(() => formatWordCount(props.document.wordCount))
const relativeDate = computed(() => formatRelativeTime(props.document.displayedDate, props.now))
const absoluteDate = computed(() => formatAbsoluteTime(props.document.displayedDate))
</script>
