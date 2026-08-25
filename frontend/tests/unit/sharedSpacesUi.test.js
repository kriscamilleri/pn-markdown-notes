// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive } from 'vue';

const SPACE_KEY = 'space:22222222-2222-4222-8222-222222222222';
const router = { push: vi.fn() };
const syncStore = reactive({
  personalDbKey: 'user:11111111-1111-4111-8111-111111111111',
  bootstrapState: { status: 'loading', completed: 0, total: 2, error: null },
  retryBootstrap: vi.fn(async () => {}),
  removeDatabase: vi.fn(async () => {}),
});
const docStore = reactive({
  rootItems: [],
  openFolders: new Set(),
  selectedFileId: null,
  selectedFolderId: null,
  selectedFile: null,
  syncStore,
  isFolderOpen: vi.fn(() => false),
  getChildren: vi.fn(async () => []),
  loadRootItems: vi.fn(async () => {}),
  selectFolder: vi.fn(),
  selectFile: vi.fn(),
  toggleFolder: vi.fn(),
});
const structureStore = reactive({
  selectedFolderId: null,
  selectedDbKey: null,
  moveItem: vi.fn(),
});

vi.mock('vue-router', () => ({ useRouter: () => router }));
vi.mock('@/store/docStore', () => ({ useDocStore: () => docStore }));
vi.mock('@/store/structureStore', () => ({ useStructureStore: () => structureStore }));
vi.mock('@/store/syncStore', () => ({ useSyncStore: () => syncStore }));
vi.mock('@/store/spaceTransferStore', () => ({
  useSpaceTransferStore: () => ({ begin: vi.fn(), recoverable: [], loadRecoverable: vi.fn() }),
}));
vi.mock('@/store/conflictStore', () => ({
  useConflictStore: () => ({ hasConflict: () => false }),
}));
vi.mock('@/store/uiStore', () => ({
  useUiStore: () => ({ addToast: vi.fn() }),
}));

const TreeItem = (await import('@/components/TreeItem.vue')).default;
const Documents = (await import('@/components/Documents.vue')).default;
const RecentDocumentRow = (await import('@/components/RecentDocumentRow.vue')).default;

const mounted = [];
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  vi.clearAllMocks();
});

describe('shared-space UI', () => {
  it('renders a space root with the existing avatar stack and recoverable quota actions', async () => {
    const wrapper = mount(TreeItem, {
      props: {
        item: {
          id: SPACE_KEY,
          dbKey: SPACE_KEY,
          type: 'space',
          name: 'Writers',
          status: 'quota-error',
          error: 'This space could not be stored on this device.',
          members: [
            { id: 'member-a', name: 'Alice' },
            { id: 'member-b', name: 'Bob' },
          ],
        },
      },
    });
    mounted.push(wrapper);

    expect(wrapper.text()).toContain('Writers');
    expect(wrapper.find('[data-testid="avatar-stack"]').exists()).toBe(true);
    expect(wrapper.find(`[data-testid="tree-item-folder-menu-${SPACE_KEY}"]`).exists()).toBe(true);
    expect(wrapper.find(`[data-testid="space-recovery-${SPACE_KEY}"]`).text())
      .toContain('Remove locally');

    const buttons = wrapper.findAll(`[data-testid="space-recovery-${SPACE_KEY}"] button`);
    await buttons[0].trigger('click');
    await buttons[1].trigger('click');
    expect(syncStore.retryBootstrap).toHaveBeenCalledWith(SPACE_KEY);
    expect(syncStore.removeDatabase).toHaveBeenCalledWith(SPACE_KEY);
  });

  it('shows one-at-a-time bootstrap progress without replacing the personal tree', () => {
    docStore.rootItems = [{
      id: 'personal-note',
      treeKey: `${syncStore.personalDbKey}:personal-note`,
      dbKey: syncStore.personalDbKey,
      type: 'file',
      name: 'Private Document',
    }];
    const wrapper = mount(Documents, {
      global: {
        stubs: {
          TreeItem: { props: ['item'], template: '<div data-testid="stub-tree-item">{{ item.name }}</div>' },
          TemplatePickerModal: true,
          PromptModal: true,
          DocumentTransferPanel: true,
        },
      },
    });
    mounted.push(wrapper);

    expect(wrapper.find('[data-testid="space-bootstrap-progress"]').text())
      .toContain('Loading shared space 1 of 2');
    expect(wrapper.find('[data-testid="stub-tree-item"]').text()).toBe('Private Document');
  });

  it('labels a shared dashboard Document with its visibility context', () => {
    const wrapper = mount(RecentDocumentRow, {
      props: {
        document: {
          id: 'note-a',
          dbKey: SPACE_KEY,
          name: 'Plan',
          folderName: 'Roadmap',
          spaceName: 'Writers',
          displayedDate: '2026-08-18T10:00:00Z',
          wordCount: 12,
          isPinned: false,
        },
      },
    });
    mounted.push(wrapper);
    expect(wrapper.find('[data-testid="document-row-space-note-a"]').text()).toBe('Shared in Writers');
  });
});
