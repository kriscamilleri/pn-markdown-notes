<!-- frontend/src/components/FolderNavigationList.vue -->
<template>
    <!--
        Immediate child folders of the selected folder. Deliberately outside the
        document filter pipeline: the quick filter and the Pinned filter narrow
        documents, never navigation.
    -->
    <section
        v-if="folders.length"
        class="mb-4"
        aria-labelledby="folder-navigation-heading"
        data-testid="folder-navigation"
    >
        <h3
            id="folder-navigation-heading"
            class="mb-2 uppercase tracking-wide pn-meta"
        >
            Folders
        </h3>

        <ul class="flex flex-wrap gap-2">
            <li
                v-for="folder in folders"
                :key="folder.treeKey || folder.id"
            >
                <button
                    type="button"
                    class="inline-flex min-h-[40px] max-w-full items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 focus-visible:ring-offset-2"
                    :data-testid="`folder-navigation-item-${folder.id}`"
                    @click="$emit('open-folder', folder)"
                >
                    <Folder
                        class="h-4 w-4 shrink-0 text-gray-500"
                        aria-hidden="true"
                    />
                    <span class="truncate">{{ folder.name }}</span>
                </button>
            </li>
        </ul>
    </section>
</template>

<script setup>
import { Folder } from 'lucide-vue-next'

defineProps({
    folders: { type: Array, default: () => [] },
})

defineEmits(['open-folder'])
</script>
