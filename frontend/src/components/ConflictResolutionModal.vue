<template>
    <BaseModal
        :show="show"
        title="Resolve document changes"
        :subtitle="subtitle"
        size="lg"
        :close-on-backdrop="false"
        close-testid="conflict-resolution-close"
        @close="$emit('close')"
    >
        <div v-if="plan.status === 'conflict'" class="space-y-6">
            <section
                v-for="region in conflictRegions"
                :key="region.index"
                class="rounded-lg border border-amber-200 bg-amber-50/30 p-4"
                :data-testid="`conflict-region-${region.index}`"
            >
                <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <h4 class="pn-title-sub">Region {{ region.index + 1 }} of {{ conflictRegions.length }}</h4>
                    <div class="flex gap-2" role="group" :aria-label="`Decision for region ${region.index + 1}`">
                        <BaseButton
                            size="sm"
                            variant="secondary"
                            :is-active="decisions[region.index] === 'mine'"
                            :aria-pressed="decisions[region.index] === 'mine'"
                            :disabled="applying"
                            :data-testid="`conflict-region-${region.index}-mine`"
                            @click="choose(region.index, 'mine')"
                        >Keep mine</BaseButton>
                        <BaseButton
                            size="sm"
                            variant="secondary"
                            :is-active="decisions[region.index] === 'theirs'"
                            :aria-pressed="decisions[region.index] === 'theirs'"
                            :disabled="applying"
                            :data-testid="`conflict-region-${region.index}-theirs`"
                            @click="choose(region.index, 'theirs')"
                        >Use theirs</BaseButton>
                    </div>
                </div>
                <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <div class="min-h-40 overflow-hidden rounded border border-gray-200 bg-white">
                        <p class="border-b border-gray-200 px-3 py-2 text-sm font-medium text-gray-700">Your version</p>
                        <DiffView
                            class="max-h-64"
                            :old-text="region.baseLines.join('\n')"
                            :new-text="region.mineLines.join('\n')"
                        />
                    </div>
                    <div class="min-h-40 overflow-hidden rounded border border-gray-200 bg-white">
                        <p class="border-b border-gray-200 px-3 py-2 text-sm font-medium text-gray-700">Remote version</p>
                        <DiffView
                            class="max-h-64"
                            :old-text="region.baseLines.join('\n')"
                            :new-text="region.theirsLines.join('\n')"
                        />
                    </div>
                </div>
            </section>
        </div>

        <div v-else-if="plan.status === 'clean'" data-testid="conflict-clean-candidate">
            <p class="mb-3 pn-body">The non-overlapping changes can be combined into one document.</p>
            <div class="h-[50vh] overflow-hidden rounded border border-gray-200">
                <DiffView :old-text="plan.theirs" :new-text="plan.content" />
            </div>
        </div>

        <div v-else class="space-y-4" data-testid="conflict-budget-fallback">
            <p class="pn-body">This document is too large for per-region comparison. Choose the complete version to keep.</p>
            <div class="flex flex-wrap gap-2">
                <BaseButton
                    size="sm"
                    variant="secondary"
                    :is-active="wholeChoice === 'mine'"
                    :aria-pressed="wholeChoice === 'mine'"
                    :disabled="applying"
                    data-testid="conflict-budget-mine"
                    @click="wholeChoice = 'mine'"
                >Keep mine</BaseButton>
                <BaseButton
                    size="sm"
                    variant="secondary"
                    :is-active="wholeChoice === 'theirs'"
                    :aria-pressed="wholeChoice === 'theirs'"
                    :disabled="applying"
                    data-testid="conflict-budget-theirs"
                    @click="wholeChoice = 'theirs'"
                >Use theirs</BaseButton>
            </div>
        </div>

        <template #footer>
            <BaseButton variant="secondary" size="md" :disabled="applying" @click="$emit('close')">Cancel</BaseButton>
            <BaseButton
                variant="primary"
                size="md"
                :disabled="!canApply || applying"
                data-testid="conflict-resolution-apply"
                @click="apply"
            >{{ applying ? 'Applying…' : 'Apply' }}</BaseButton>
        </template>
    </BaseModal>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import {
    applyConflictResolution,
    buildConflictResolutionPlan,
} from '@panino/content-merge';
import BaseButton from '@/components/BaseButton.vue';
import BaseModal from '@/components/BaseModal.vue';
import DiffView from '@/components/DiffView.vue';

const props = defineProps({
    show: { type: Boolean, default: false },
    conflict: { type: Object, required: true },
    applying: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'apply']);
const decisions = ref({});
const wholeChoice = ref(null);

const plan = computed(() => buildConflictResolutionPlan({
    base: props.conflict.baseContent,
    mine: props.conflict.mineContent,
    theirs: props.conflict.theirsContent,
}));
const conflictRegions = computed(() => plan.value.regions.filter((region) => region.type === 'conflict'));
const subtitle = computed(() => {
    if (plan.value.status === 'conflict') {
        const count = conflictRegions.value.length;
        return `Some changes merged automatically. ${count} ${count === 1 ? 'region needs' : 'regions need'} a decision.`;
    }
    if (plan.value.status === 'clean') return 'Review the automatically combined result before applying it.';
    return 'Automatic comparison is unavailable for this document.';
});
const canApply = computed(() => {
    if (plan.value.status === 'clean') return true;
    if (plan.value.status === 'budget') return wholeChoice.value === 'mine' || wholeChoice.value === 'theirs';
    return conflictRegions.value.every((region) => ['mine', 'theirs'].includes(decisions.value[region.index]));
});

watch(
    () => [props.show, props.conflict.updatedAt, props.conflict.mergeAttempts],
    () => {
        decisions.value = {};
        wholeChoice.value = null;
    },
);

function choose(index, choice) {
    decisions.value = { ...decisions.value, [index]: choice };
}

function apply() {
    if (!canApply.value) return;
    let content;
    if (plan.value.status === 'clean') content = plan.value.content;
    else if (plan.value.status === 'budget') content = wholeChoice.value === 'mine' ? plan.value.mine : plan.value.theirs;
    else content = applyConflictResolution(plan.value, decisions.value);
    emit('apply', content);
}
</script>
