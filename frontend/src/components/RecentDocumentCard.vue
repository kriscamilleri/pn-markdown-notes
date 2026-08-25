<!-- frontend/src/components/RecentDocumentCard.vue -->
<template>
    <!--
        A Continue Writing card. Global Recent Documents only — folder views get
        the header and grouped list without this rail.
    -->
    <div
        class="pn-panel relative flex cursor-pointer flex-col gap-1 p-4 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 focus-visible:ring-offset-2"
        role="button"
        tabindex="0"
        :aria-label="`Open ${document.name}`"
        :data-testid="`continue-writing-card-${document.id}`"
        @click="$emit('open', document)"
        @keydown.enter.prevent="$emit('open', document)"
        @keydown.space.prevent="$emit('open', document)"
    >
        <div class="flex items-start justify-between gap-2">
            <span
                class="min-w-0 truncate font-medium text-blue-600"
                :title="document.name"
                :data-testid="`continue-writing-title-${document.id}`"
            >
                {{ document.name }}
            </span>

            <DocumentPinButton
                class="-mr-2 -mt-2"
                :document-id="document.id"
                :document-name="document.name"
                :is-pinned="document.isPinned"
                @toggle="$emit('toggle-pin', document)"
            />
        </div>

        <span
            v-if="document.spaceName"
            class="pn-meta"
            :data-testid="`continue-writing-space-${document.id}`"
        >Shared in {{ document.spaceName }}</span>

        <span
            class="truncate pn-meta"
            :title="document.folderName"
            :data-testid="`continue-writing-folder-${document.id}`"
        >
            {{ document.folderName }}
        </span>

        <span
            class="pn-meta"
            :title="absoluteDate"
            :data-testid="`continue-writing-meta-${document.id}`"
        >
            {{ wordCountLabel }} · Edited {{ relativeDate }}
        </span>

        <p
            v-if="document.excerpt"
            class="mt-1 line-clamp-2 pn-body"
            :data-testid="`continue-writing-excerpt-${document.id}`"
        >
            {{ document.excerpt }}
        </p>
    </div>
</template>

<script setup>
import { computed } from 'vue'
import DocumentPinButton from '@/components/DocumentPinButton.vue'
import { formatAbsoluteTime, formatRelativeTime, formatWordCount } from '@/utils/recentDocuments.js'

const props = defineProps({
    document: { type: Object, required: true },
    /** Injectable clock so the rendered label is deterministic under test. */
    now: { type: Number, default: () => Date.now() },
})

defineEmits(['open', 'toggle-pin'])

const wordCountLabel = computed(() => formatWordCount(props.document.wordCount))
const relativeDate = computed(() => formatRelativeTime(props.document.displayedDate, props.now))
const absoluteDate = computed(() => formatAbsoluteTime(props.document.displayedDate))
</script>
