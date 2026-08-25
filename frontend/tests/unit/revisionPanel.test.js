// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const SPACE_DB_KEY = 'space:22222222-2222-4222-8222-222222222222';
const harness = vi.hoisted(() => ({
  docStore: {
    selectedFileId: 'space-note',
    selectedDbKey: 'space:22222222-2222-4222-8222-222222222222',
    selectedFile: { id: 'space-note', title: 'Shared', content: '# current' },
    loadRootItems: vi.fn(async () => {}),
  },
  revisionStore: {
    revisions: [{
      id: 'space-rev',
      title: 'Shared checkpoint',
      type: 'manual',
      createdAt: '2026-08-18T20:00:00.000Z',
      actor: { id: 'actor-1', name: 'Alice Example' },
    }],
    selectedRevisionId: null,
    selectedRevisionDetail: null,
    isListLoading: false,
    listError: '',
    isDetailLoading: false,
    detailError: '',
    isActionLoading: false,
    hasMore: false,
    resetState: vi.fn(),
    fetchRevisions: vi.fn(async () => {}),
    fetchRevisionDetail: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    saveManualRevision: vi.fn(async () => ({ created: true })),
    restoreRevision: vi.fn(async () => null),
  },
  addToast: vi.fn(),
}));

vi.mock('@/store/docStore', () => ({ useDocStore: () => harness.docStore }));
vi.mock('@/store/revisionStore', () => ({ useRevisionStore: () => harness.revisionStore }));
vi.mock('@/store/uiStore', () => ({ useUiStore: () => ({ addToast: harness.addToast }) }));

const RevisionPanel = (await import('@/components/RevisionPanel.vue')).default;

describe('RevisionPanel shared-space support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads qualified shared history and renders the server-provided actor name', async () => {
    const wrapper = mount(RevisionPanel, {
      props: { standalone: true },
      global: { stubs: { DiffView: true } },
    });
    await flushPromises();

    expect(harness.revisionStore.fetchRevisions).toHaveBeenCalledWith(
      SPACE_DB_KEY,
      'space-note',
      { reset: true, limit: 50 },
    );
    expect(wrapper.find('[data-testid="revision-panel-space-unavailable"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="revision-actor-space-rev"]').text()).toBe('by Alice Example');
    wrapper.unmount();
  });
});
