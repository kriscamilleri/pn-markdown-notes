// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ConflictResolutionModal from '../../src/components/ConflictResolutionModal.vue';
import { CONTENT_MERGE_LIMITS } from '@panino/content-merge';

function conflict(overrides = {}) {
    return {
        noteId: 'note-a',
        baseContent: 'same\ngap\nsame',
        mineContent: 'mine one\ngap\nmine two',
        theirsContent: 'theirs one\ngap\ntheirs two',
        updatedAt: '2026-08-16T20:00:00.000Z',
        mergeAttempts: 1,
        ...overrides,
    };
}

describe('ConflictResolutionModal (COLLAB-02 §6.2)', () => {
    it('renders each conflict region and requires an independent decision', async () => {
        const wrapper = mount(ConflictResolutionModal, {
            props: { show: true, conflict: conflict() },
        });

        expect(wrapper.findAll('[data-testid^="conflict-region-"]').filter((node) => /^conflict-region-\d+$/.test(node.attributes('data-testid')))).toHaveLength(2);
        const apply = wrapper.get('[data-testid="conflict-resolution-apply"]');
        expect(apply.attributes('disabled')).toBeDefined();

        await wrapper.get('[data-testid="conflict-region-0-mine"]').trigger('click');
        expect(apply.attributes('disabled')).toBeDefined();
        expect(wrapper.get('[data-testid="conflict-region-0-mine"]').attributes('aria-pressed')).toBe('true');

        await wrapper.get('[data-testid="conflict-region-1-theirs"]').trigger('click');
        expect(apply.attributes('disabled')).toBeUndefined();
        await apply.trigger('click');
        expect(wrapper.emitted('apply')).toEqual([['mine one\ngap\ntheirs two']]);
    });

    it('offers one Apply action for a clean manual merge candidate', async () => {
        const wrapper = mount(ConflictResolutionModal, {
            props: {
                show: true,
                conflict: conflict({
                    baseContent: 'p1\n\np2',
                    mineContent: 'p1 mine\n\np2',
                    theirsContent: 'p1\n\np2 theirs',
                }),
            },
        });

        expect(wrapper.find('[data-testid="conflict-clean-candidate"]').exists()).toBe(true);
        await wrapper.get('[data-testid="conflict-resolution-apply"]').trigger('click');
        expect(wrapper.emitted('apply')).toEqual([['p1 mine\n\np2 theirs']]);
    });

    it('uses a whole-document fallback when the merge budget is exceeded', async () => {
        const mineContent = 'x'.repeat(CONTENT_MERGE_LIMITS.maxContentBytes + 1);
        const wrapper = mount(ConflictResolutionModal, {
            props: {
                show: true,
                conflict: conflict({ baseContent: 'base', mineContent, theirsContent: 'remote' }),
            },
        });

        expect(wrapper.find('[data-testid="conflict-budget-fallback"]').exists()).toBe(true);
        await wrapper.get('[data-testid="conflict-budget-mine"]').trigger('click');
        await wrapper.get('[data-testid="conflict-resolution-apply"]').trigger('click');
        expect(wrapper.emitted('apply')).toEqual([[mineContent]]);
    });

    it('closes without applying and disables decisions while applying', async () => {
        const wrapper = mount(ConflictResolutionModal, {
            props: { show: true, conflict: conflict(), applying: true },
        });

        expect(wrapper.get('[data-testid="conflict-region-0-mine"]').attributes('disabled')).toBeDefined();
        await wrapper.get('[data-testid="conflict-resolution-close"]').trigger('click');
        expect(wrapper.emitted('close')).toHaveLength(1);
        expect(wrapper.emitted('apply')).toBeUndefined();
    });
});
