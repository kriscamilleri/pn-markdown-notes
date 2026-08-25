import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../src/store/authStore.js', () => ({
  useAuthStore: () => ({ token: 'test-token' }),
}));

import { useRevisionStore } from '../../src/store/revisionStore.js';

const PERSONAL_DB_KEY = 'user:11111111-1111-4111-8111-111111111111';
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const SPACE_DB_KEY = `space:${SPACE_ID}`;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('revisionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('loads first page and sets pagination state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      revisions: [
        {
          id: 'rev-1',
          noteId: 'note-1',
          title: 'Title',
          type: 'auto',
          createdAt: '2026-02-17T10:00:00.000Z',
          uncompressedBytes: 20,
          compressedBytes: 10,
        },
      ],
    }));

    const store = useRevisionStore();
    await store.fetchRevisions(PERSONAL_DB_KEY, 'note-1', { reset: true, limit: 50 });

    expect(store.revisions).toHaveLength(1);
    expect(store.hasMore).toBe(false);
    expect(store.listError).toBe('');
  });

  it('qualifies every shared-space revision route and keeps server-derived actor display', async () => {
    const listedRevision = {
      id: 'space-rev-1',
      noteId: 'space-note',
      title: 'Shared title',
      type: 'manual',
      createdAt: '2026-08-18T20:00:00.000Z',
      uncompressedBytes: 20,
      compressedBytes: 10,
      actor: { id: 'actor-1', name: 'Alice Example' },
      actorKind: 'system',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ revisions: [listedRevision] }))
      .mockResolvedValueOnce(jsonResponse({
        revision: { ...listedRevision, content: '# shared' },
      }))
      .mockResolvedValueOnce(jsonResponse({ created: true, revisionId: 'space-rev-2' }, 201))
      .mockResolvedValueOnce(jsonResponse({ revisions: [listedRevision] }))
      .mockResolvedValueOnce(jsonResponse({
        restored: true,
        note: { id: 'space-note', title: 'Shared title', content: '# shared', updatedAt: 'now' },
      }))
      .mockResolvedValueOnce(jsonResponse({ revisions: [listedRevision] }));

    const store = useRevisionStore();
    await store.fetchRevisions(SPACE_DB_KEY, 'space-note');
    expect(store.revisions[0].actor).toEqual({ id: 'actor-1', name: 'Alice Example' });
    await store.fetchRevisionDetail(SPACE_DB_KEY, 'space-note', 'space-rev-1');
    await store.saveManualRevision(SPACE_DB_KEY, 'space-note');
    await store.restoreRevision(SPACE_DB_KEY, 'space-note', 'space-rev-1');

    const urls = fetchSpy.mock.calls.map(([url]) => new URL(url));
    expect(urls).toHaveLength(6);
    for (const url of urls) {
      expect(url.searchParams.get('space')).toBe(SPACE_ID);
    }
    expect(urls.map((url) => url.pathname)).toEqual([
      '/notes/space-note/revisions',
      '/notes/space-note/revisions/space-rev-1',
      '/notes/space-note/revisions',
      '/notes/space-note/revisions',
      '/notes/space-note/revisions/space-rev-1/restore',
      '/notes/space-note/revisions',
    ]);
  });

  it('fetches detail lazily and caches result', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      revision: {
        id: 'rev-1',
        noteId: 'note-1',
        title: 'Title',
        type: 'manual',
        createdAt: '2026-02-17T10:00:00.000Z',
        content: '# markdown',
      },
    }));

    const store = useRevisionStore();
    await store.fetchRevisionDetail(PERSONAL_DB_KEY, 'note-1', 'rev-1');
    await store.fetchRevisionDetail(PERSONAL_DB_KEY, 'note-1', 'rev-1');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.selectedRevisionId).toBe('rev-1');
    expect(store.selectedRevisionDetail.content).toBe('# markdown');
  });

  it('scopes cached revision details to their database and Document', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        revision: { id: 'same-revision', noteId: 'note-1', content: '# personal' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        revision: { id: 'same-revision', noteId: 'note-1', content: '# shared' },
      }));

    const store = useRevisionStore();
    await store.fetchRevisionDetail(PERSONAL_DB_KEY, 'note-1', 'same-revision');
    await store.fetchRevisionDetail(SPACE_DB_KEY, 'note-1', 'same-revision');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(store.selectedRevisionDetail.content).toBe('# shared');
  });

  it('restores revision and refreshes list', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({
        restored: true,
        note: {
          id: 'note-1',
          title: 'Restored',
          content: '# restored',
          updatedAt: '2026-02-17T11:00:00.000Z',
        },
        preRestoreRevisionId: 'rev-pre',
      }))
      .mockResolvedValueOnce(jsonResponse({ revisions: [] }));

    const store = useRevisionStore();
    const result = await store.restoreRevision(PERSONAL_DB_KEY, 'note-1', 'rev-1', '2026-02-17T10:00:00.000Z');

    expect(result.restored).toBe(true);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8000/notes/note-1/revisions/rev-1/restore',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('clears opened revision state when resetState is called (close behavior)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        revision: {
          id: 'rev-1',
          noteId: 'note-1',
          title: 'Title',
          type: 'manual',
          createdAt: '2026-02-17T10:00:00.000Z',
          content: '# markdown',
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        revision: {
          id: 'rev-1',
          noteId: 'note-1',
          title: 'Title',
          type: 'manual',
          createdAt: '2026-02-17T10:00:00.000Z',
          content: '# markdown',
        },
      }));

    const store = useRevisionStore();
    await store.fetchRevisionDetail(PERSONAL_DB_KEY, 'note-1', 'rev-1');
    expect(store.selectedRevisionId).toBe('rev-1');
    expect(store.selectedRevisionDetail.content).toBe('# markdown');

    store.resetState();
    expect(store.selectedRevisionId).toBe(null);
    expect(store.selectedRevisionDetail).toBe(null);

    await store.fetchRevisionDetail(PERSONAL_DB_KEY, 'note-1', 'rev-1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('clears selected revision when restore refresh no longer includes that revision', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({
        revision: {
          id: 'rev-selected',
          noteId: 'note-1',
          title: 'Old',
          type: 'manual',
          createdAt: '2026-02-17T10:00:00.000Z',
          content: '# old',
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        restored: true,
        note: {
          id: 'note-1',
          title: 'Restored',
          content: '# restored',
          updatedAt: '2026-02-17T11:00:00.000Z',
        },
        preRestoreRevisionId: 'rev-pre',
      }))
      .mockResolvedValueOnce(jsonResponse({
        revisions: [
          {
            id: 'rev-other',
            noteId: 'note-1',
            title: 'Other',
            type: 'auto',
            createdAt: '2026-02-17T11:00:01.000Z',
            uncompressedBytes: 12,
            compressedBytes: 8,
          },
        ],
      }));

    const store = useRevisionStore();
    await store.fetchRevisionDetail(PERSONAL_DB_KEY, 'note-1', 'rev-selected');
    expect(store.selectedRevisionId).toBe('rev-selected');

    await store.restoreRevision(PERSONAL_DB_KEY, 'note-1', 'rev-selected', '2026-02-17T10:00:00.000Z');
    expect(store.selectedRevisionId).toBe(null);
    expect(store.revisions.map((r) => r.id)).toEqual(['rev-other']);
  });

  it('reopens the same revision id after restore by refetching detail', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({
        revision: {
          id: 'rev-selected',
          noteId: 'note-1',
          title: 'Checkpoint',
          type: 'manual',
          createdAt: '2026-02-17T10:00:00.000Z',
          content: '# checkpoint',
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        restored: true,
        note: {
          id: 'note-1',
          title: 'Restored',
          content: '# restored',
          updatedAt: '2026-02-17T11:00:00.000Z',
        },
        preRestoreRevisionId: 'rev-pre',
      }))
      .mockResolvedValueOnce(jsonResponse({
        revisions: [
          {
            id: 'rev-selected',
            noteId: 'note-1',
            title: 'Checkpoint',
            type: 'manual',
            createdAt: '2026-02-17T10:00:00.000Z',
            uncompressedBytes: 12,
            compressedBytes: 8,
          },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        revision: {
          id: 'rev-selected',
          noteId: 'note-1',
          title: 'Checkpoint',
          type: 'manual',
          createdAt: '2026-02-17T10:00:00.000Z',
          content: '# checkpoint',
        },
      }));

    const store = useRevisionStore();

    await store.fetchRevisionDetail(PERSONAL_DB_KEY, 'note-1', 'rev-selected');
    expect(store.selectedRevisionId).toBe('rev-selected');
    expect(store.selectedRevisionDetail.content).toBe('# checkpoint');

    await store.restoreRevision(PERSONAL_DB_KEY, 'note-1', 'rev-selected', '2026-02-17T10:00:00.000Z');
    expect(store.selectedRevisionId).toBe(null);

    await store.fetchRevisionDetail(PERSONAL_DB_KEY, 'note-1', 'rev-selected');
    expect(store.selectedRevisionId).toBe('rev-selected');
    expect(store.selectedRevisionDetail.content).toBe('# checkpoint');
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
