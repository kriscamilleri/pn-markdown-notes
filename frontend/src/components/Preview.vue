<template>
    <div v-if="file">
        <!-- `renderedHtml` is sanitized with DOMPurify below. -->
        <div
            class="mt-2"
            v-html="renderedHtml"
            data-testid="preview-content"
        ></div>
    </div>
    <div
        v-else
        data-testid="preview-no-file"
    >
        <p class="text-gray-500">No file selected</p>
    </div>
</template>

<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useDocStore } from '@/store/docStore'
import { useDraftStore } from '@/store/draftStore'
import { useMarkdownStore } from '@/store/markdownStore'
import DOMPurify from 'dompurify'

const docStore = useDocStore()
const draftStore = useDraftStore()
const markdownStore = useMarkdownStore()

// pull the ref directly
const { selectedFile: file, selectedFileContent } = storeToRefs(docStore)

// preview text = draft if present, else DB content
const text = computed(() => {
    if (!file.value) return ''
    const draft = draftStore.getDraft(file.value.id)
    return draft || selectedFileContent.value
})

const renderedHtml = computed(() => {
    const md = docStore.getMarkdownIt()
    const source = markdownStore.applyMetadataVariables(text.value || '')
    const withPageBreaks = source
        .replace(/\\pagebreak/g, '\n<div class="pagebreak-banner" data-pagebreak="true">Page break</div>\n')
        .replace(/<!--\s*pagebreak\s*-->/g, '\n<div class="pagebreak-banner" data-pagebreak="true">Page break</div>\n')
        .replace(/---\s*pagebreak\s*---/gi, '\n<div class="pagebreak-banner" data-pagebreak="true">Page break</div>\n')
    const raw = md.render(withPageBreaks)
    return DOMPurify.sanitize(raw)
})
</script>

<style scoped>
:deep(.pagebreak-banner) {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 2rem 0;
    width: 100%;
    color: #6b7280;
    font-size: 0.7rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    user-select: none;
    background: #f9fafb;
    padding: 0.35rem 0.85rem;
}

:deep(.pagebreak-banner)::before,
:deep(.pagebreak-banner)::after {
    content: '';
    flex: 1 1 auto;
    height: 1px;
    background-color: rgba(156, 163, 175, 0.6);
}
</style>
