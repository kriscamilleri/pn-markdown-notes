// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { mount } from '@vue/test-utils';

const uiStoreMock = reactive({
    toasts: [{ id: 'toast-1', type: 'info', message: '<img src=x onerror=alert(1)>' }],
    removeToast: vi.fn(),
});

vi.mock('@/store/uiStore', () => ({ useUiStore: () => uiStoreMock }));

const ToastContainer = (await import('@/components/ToastContainer.vue')).default;

describe('ToastContainer', () => {
    it('renders toast messages as text rather than executable HTML', () => {
        const wrapper = mount(ToastContainer);

        expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>');
        expect(wrapper.find('img').exists()).toBe(false);
    });
});
