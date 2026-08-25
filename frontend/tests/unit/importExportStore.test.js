import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import JSZip from 'jszip';

let authStore;
let syncStore;
let docStore;

vi.mock('../../src/store/authStore.js', () => ({
    useAuthStore: () => authStore,
}));

vi.mock('../../src/store/syncStore.js', () => ({
    useSyncStore: () => syncStore,
}));

vi.mock('../../src/store/docStore.js', () => ({
    useDocStore: () => docStore,
}));

vi.mock('file-saver', () => ({
    saveAs: vi.fn(),
}));

import { useImportExportStore } from '../../src/store/importExportStore.js';

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createMockDb() {
    const tables = {
        folders: [],
        notes: [],
    };

    return {
        tables,
        exec: vi.fn(async (sql, params = []) => {
            if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
                return;
            }

            if (sql.startsWith('INSERT INTO folders')) {
                tables.folders.push({
                    id: params[0],
                    user_id: params[1],
                    name: params[2],
                    parent_id: params[3],
                    created_at: params[4],
                });
                return;
            }

            if (sql.startsWith('INSERT INTO notes')) {
                tables.notes.push({
                    id: params[0],
                    user_id: params[1],
                    folder_id: params[2],
                    title: params[3],
                    content: params[4],
                    created_at: params[5],
                    updated_at: params[6],
                });
                return;
            }

            if (sql.startsWith('UPDATE notes SET content = ?, updated_at = ? WHERE id = ?')) {
                const existingNote = tables.notes.find((note) => note.id === params[2]);
                if (existingNote) {
                    existingNote.content = params[0];
                    existingNote.updated_at = params[1];
                }
            }
        }),
    };
}

function createMockSyncStore(db) {
    const execute = vi.fn(async (sql, params = []) => {
        if (sql.includes('FROM folders WHERE parent_id IS ? AND name = ?')) {
            const parentId = params[0] ?? null;
            const name = params[1];
            return db.tables.folders.filter(
                (folder) => folder.parent_id === parentId && folder.name === name
            );
        }

        if (sql.includes('FROM notes WHERE folder_id IS ? AND title = ?')) {
            const folderId = params[0] ?? null;
            const title = params[1];
            return db.tables.notes.filter(
                (note) => note.folder_id === folderId && note.title === title
            );
        }

        return [];
    });
    const repository = { execute, exec: db.exec };
    return {
        isInitialized: true,
        isOnline: true,
        syncEnabled: true,
        db: { value: db },
        sync: vi.fn(async () => {}),
        personalRepository: vi.fn(() => repository),
    };
}

describe('importExportStore ZIP imports', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.restoreAllMocks();

        authStore = {
            user: { id: 'user-1' },
            isAuthenticated: true,
            token: 'test-token',
        };

        const db = createMockDb();
        syncStore = createMockSyncStore(db);
        docStore = {
            loadInitialData: vi.fn(async () => {}),
        };
    });

    it('re-uploads bundled Panino ZIP images and rewrites imported markdown references', async () => {
        const oldImageId = '11111111-1111-1111-1111-111111111111';
        const newImageId = '22222222-2222-2222-2222-222222222222';
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({ id: newImageId, url: `/images/${newImageId}` }, 201)
        );

        const zip = new JSZip();
        zip.file('Trips/Beach.md', `![Beach](/images/${oldImageId})\n`);
        zip.file('_images/beach.png', new Uint8Array([137, 80, 78, 71]));
        zip.file('_panino_metadata.json', JSON.stringify({
            version: 2,
            images: [
                {
                    id: oldImageId,
                    filename: 'beach.png',
                    mime_type: 'image/png',
                    zipPath: '_images/beach.png',
                },
            ],
        }));

        const archive = await zip.generateAsync({ type: 'uint8array' });

        const store = useImportExportStore();
        const result = await store.importZipArchive(archive);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledWith(
            expect.stringMatching(/\/images$/),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
                body: expect.any(FormData),
            })
        );

        const uploadedImage = fetchSpy.mock.calls[0][1].body.get('image');
        expect(uploadedImage).toBeInstanceOf(Blob);
        expect(uploadedImage.type).toBe('image/png');

        expect(syncStore.db.value.tables.folders).toHaveLength(1);
        expect(syncStore.db.value.tables.folders[0]).toMatchObject({ name: 'Trips', parent_id: null });
        expect(syncStore.db.value.tables.notes).toHaveLength(1);
        expect(syncStore.db.value.tables.notes[0].title).toBe('Beach');
        expect(syncStore.db.value.tables.notes[0].content).toContain(`/images/${newImageId}`);
        expect(syncStore.db.value.tables.notes[0].content).not.toContain(oldImageId);

        expect(result).toMatchObject({
            created: 1,
            updated: 0,
            unchanged: 0,
            foldersCreated: 1,
            overwriteCount: 0,
            skippedItems: [],
        });
        expect(docStore.loadInitialData).toHaveBeenCalledTimes(1);
    });
});
