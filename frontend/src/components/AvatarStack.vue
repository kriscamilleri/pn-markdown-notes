<template>
    <div class="flex items-center -space-x-2" data-testid="avatar-stack">
        <UserAvatar
            v-for="user in visibleUsers"
            :key="user.id"
            :user="user"
            :size="size"
            :show-tooltip="showTooltip"
        />
        <span
            v-if="overflow > 0"
            class="inline-flex items-center justify-center rounded-full bg-gray-200 text-gray-700 font-semibold ring-2 ring-white"
            :style="overflowStyle"
            :data-testid="'avatar-stack-overflow'"
        >+{{ overflow }}</span>
    </div>
</template>

<script setup>
import { computed } from 'vue';
import UserAvatar from '@/components/UserAvatar.vue';

const props = defineProps({
    users: { type: Array, default: () => [] },
    /** Maximum number of overlapping avatars before collapsing into a +N pill. */
    max: { type: Number, default: 5 },
    size: { type: String, default: 'sm' },
    showTooltip: { type: Boolean, default: true },
});

const SIZE_PX = { xs: 16, sm: 24, md: 32 };

const visibleUsers = computed(() => props.users.slice(0, props.max));
const overflow = computed(() => Math.max(0, props.users.length - props.max));
const dimension = computed(() => SIZE_PX[props.size] ?? SIZE_PX.sm);
const overflowStyle = computed(() => ({
    width: `${dimension.value}px`,
    height: `${dimension.value}px`,
    fontSize: `${Math.max(9, Math.round(dimension.value * 0.4))}px`,
}));
</script>
