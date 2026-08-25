<template>
    <div class="overflow-y-auto h-full min-h-0 font-mono text-xs leading-5">
        <div
            v-for="(line, i) in items"
            :key="i"
            :class="{
                'bg-red-50 text-red-700': line.type === 'removed',
                'bg-green-50 text-green-700': line.type === 'added',
                'text-gray-600': line.type === 'unchanged',
            }"
            class="flex px-2 whitespace-pre-wrap break-all"
        >
            <span class="select-none w-4 shrink-0 mr-2 text-gray-400">{{ line.prefix }}</span><span>{{ line.text }}</span>
        </div>
        <div v-if="items.length === 0" class="p-3 text-gray-400 text-xs">No differences.</div>
    </div>
</template>

<script setup>
import { computed } from 'vue';
import { buildDiffLineItems } from '@/utils/documentDiff';

const props = defineProps({
    oldText: { type: String, default: '' },
    newText: { type: String, default: '' },
});

const items = computed(() => buildDiffLineItems(props.oldText, props.newText));
</script>
