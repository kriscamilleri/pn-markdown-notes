<template>
    <span class="relative inline-flex align-middle group">
        <span
            class="inline-flex items-center justify-center rounded-full font-semibold text-white select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 focus-visible:ring-offset-2"
            :style="swatchStyle"
            role="img"
            :aria-label="label"
            :data-testid="'user-avatar'"
            :data-user-id="userId"
            :tabindex="showTooltip ? 0 : undefined"
        >
            {{ initials }}
        </span>

        <span
            v-if="status"
            class="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-white"
            :style="statusStyle"
            role="img"
            :aria-label="`Status: ${status}`"
        ></span>

        <span
            v-if="showTooltip"
            class="pointer-events-none absolute left-1/2 top-full z-10 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-gray-800 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            role="tooltip"
        >{{ label }}</span>
    </span>
</template>

<script setup>
import { computed } from 'vue';
import { identityColorFor, initialsFor } from '@/utils/identityColor';

const props = defineProps({
    user: {
        type: Object,
        default: () => ({ id: '', name: '', email: '' }),
    },
    size: {
        type: String,
        default: 'sm',
        validator: (v) => ['xs', 'sm', 'md'].includes(v),
    },
    showTooltip: { type: Boolean, default: true },
    status: {
        type: String,
        default: null,
        validator: (v) => v === null || ['online', 'idle', 'offline'].includes(v),
    },
});

// Gray tones only: presence is a state, not an identity.
const STATUS_COLORS = {
    online: '#374151',
    idle: '#9ca3af',
    offline: '#d1d5db',
};

const FALLBACK_COLOR = '#6b7280';
const SIZE_PX = { xs: 16, sm: 24, md: 32 };

const userId = computed(() => props.user?.id ?? '');
const label = computed(() => {
    const name = (props.user?.name || '').trim();
    if (name) return name;
    const email = (props.user?.email || '').trim();
    if (email) return email;
    return 'Unknown collaborator';
});
const initials = computed(() => initialsFor(props.user?.name, props.user?.email));
const color = computed(() => (userId.value ? identityColorFor(userId.value) : FALLBACK_COLOR));

const dimension = computed(() => SIZE_PX[props.size] ?? SIZE_PX.sm);
const fontSize = computed(() => `${Math.max(9, Math.round(dimension.value * 0.4))}px`);
const swatchStyle = computed(() => ({
    width: `${dimension.value}px`,
    height: `${dimension.value}px`,
    backgroundColor: color.value,
    fontSize: fontSize.value,
}));
const statusStyle = computed(() => ({
    width: `${Math.max(6, Math.round(dimension.value * 0.35))}px`,
    height: `${Math.max(6, Math.round(dimension.value * 0.35))}px`,
    backgroundColor: STATUS_COLORS[props.status] ?? STATUS_COLORS.offline,
}));
</script>
