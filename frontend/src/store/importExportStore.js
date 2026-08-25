// /frontend/src/store/importExportStore.js
import { defineStore } from 'pinia';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { useSyncStore } from './syncStore';
import { useDocStore } from './docStore';
import { useAuthStore } from './authStore';
import { blobToBase64, replaceImageReferences } from '../utils/exportUtils';
import {
    sanitizePathSegments,
    getTextByteLength,
    isMarkdownFile,
    isHiddenSegment,
    buildFolderTree,
    validateImportLimits,
    IMPORT_LIMITS,
    extractTitleFromFrontMatter,
    titleFromFilename,
    normalizeLocalImagePath,
    collectLocalMarkdownImagePaths,
    replaceLocalMarkdownImageReferences,
} from '../utils/importUtils';

const API_URL = import.meta.env.VITE_API_SERVICE_URL || '';
const IS_PRODUCTION = import.meta.env.PROD;

/** Build the correct image URL for the current environment. */
function buildImageUrl(imageId) {
    return IS_PRODUCTION ? `/api/images/${imageId}` : `${API_URL}/images/${imageId}`;
}

function buildImageUploadUrl() {
    return IS_PRODUCTION ? '/api/images' : `${API_URL}/images`;
}

function normalizeZipEntryPath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Fetch all images from the server as { id, filename, mime_type, created_at, data }.
 * `data` is a base64 data-URL. Images that fail to download are silently skipped.
 */
async function fetchAllImageData(images, token) {
    const results = [];
    for (const img of images) {
        try {
            const url = buildImageUrl(img.id);
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) continue;
            const blob = await response.blob();
            results.push({
                id: img.id,
                filename: img.filename,
                mime_type: img.mime_type,
                created_at: img.created_at,
                data: await blobToBase64(blob),
            });
        } catch (err) {
            console.warn(`[export] Failed to fetch image ${img.id}:`, err);
        }
    }
    return results;
}

export const useImportExportStore = defineStore('importExportStore', () => {
    const syncStore = useSyncStore();
    const docStore = useDocStore();

    // ─── helpers ──────────────────────────────────────────────

    const ROOT_CACHE_KEY = '__root__';

    function buildFolderCacheKey(parentId, name) {
        return `${parentId ?? ROOT_CACHE_KEY}::${name}`;
    }

    function buildNoteCacheKey(folderId, title) {
        return `${folderId ?? ROOT_CACHE_KEY}::${title}`;
    }

    function createSkippedItem(path, reason) {
        return { path, reason };
    }

    function normalizeImportedTitle(value) {
        const title = String(value || '').trim().replace(/[\x00-\x1f]/g, '').slice(0, 500).trim();
        return title || 'Untitled';
    }

    function addFolderPathToMap(folderMap, folderPath) {
        if (!folderPath) return;

        const segments = folderPath.split('/').filter(Boolean);
        let currentPath = null;

        for (const segment of segments) {
            const fullPath = currentPath ? `${currentPath}/${segment}` : segment;
            if (!folderMap.has(fullPath)) {
                folderMap.set(fullPath, {
                    name: segment,
                    parentPath: currentPath,
                });
            }
            currentPath = fullPath;
        }
    }

    function buildImportTreeFromStructuredData(folderRows, noteRows, config) {
        const {
            folderIdKey,
            folderNameKey,
            folderParentIdKey,
            noteFolderIdKey,
            noteTitleKey,
            noteContentKey,
            noteCreatedAtKey,
            noteUpdatedAtKey,
        } = config;

        const folderById = new Map((folderRows || []).map(folder => [folder[folderIdKey], folder]));
        const pathCache = new Map();
        const folderMap = new Map();
        const notes = [];
        const skippedItems = [];

        function resolveFolderPath(folderId) {
            if (!folderId) return null;
            if (pathCache.has(folderId)) return pathCache.get(folderId);

            const folder = folderById.get(folderId);
            if (!folder) return null;

            const name = normalizeImportedTitle(folder[folderNameKey]);
            const parentId = folder[folderParentIdKey] || null;
            const parentPath = parentId ? resolveFolderPath(parentId) : null;
            const path = parentPath ? `${parentPath}/${name}` : name;
            pathCache.set(folderId, path);
            return path;
        }

        for (const folder of folderRows || []) {
            const fullPath = resolveFolderPath(folder[folderIdKey]);
            if (!fullPath) continue;
            addFolderPathToMap(folderMap, fullPath);
        }

        for (const note of noteRows || []) {
            const title = normalizeImportedTitle(note[noteTitleKey]);
            const content = String(note[noteContentKey] || '');
            const folderPath = note[noteFolderIdKey] ? resolveFolderPath(note[noteFolderIdKey]) : null;
            const virtualPath = folderPath ? `${folderPath}/${title}.md` : `${title}.md`;

            if (getTextByteLength(content) > IMPORT_LIMITS.MAX_FILE_BYTES) {
                skippedItems.push(createSkippedItem(virtualPath, 'larger than 1 MB'));
                continue;
            }

            notes.push({
                title,
                content,
                folderPath,
                createdAt: note[noteCreatedAtKey] || null,
                updatedAt: note[noteUpdatedAtKey] || null,
            });
        }

        return { folderMap, notes, skippedItems };
    }

    /** Query all core tables needed for a full export. */
    async function queryAllData() {
        const [folders, notes, images, settings, globals] = await Promise.all([
            syncStore.execute('SELECT * FROM folders'),
            syncStore.execute('SELECT * FROM notes'),
            syncStore.execute('SELECT * FROM images'),
            syncStore.execute('SELECT * FROM settings'),
            syncStore.execute('SELECT * FROM globals'),
        ]);
        return {
            folders: folders || [],
            notes: notes || [],
            images: images || [],
            settings: settings || [],
            globals: globals || [],
        };
    }

    /**
     * Read a File object as UTF-8 text.
     * @param {File} file
     * @returns {Promise<string>}
     */
    function readFileAsText(file) {
        if (typeof file?.text === 'function') {
            return file.text();
        }

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
            reader.readAsText(file);
        });
    }

    async function uploadImportedImage(blob, filename, token) {
        const formData = new FormData();
        formData.append('image', blob, filename);

        const response = await fetch(buildImageUploadUrl(), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
            },
            body: formData,
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error || 'Failed to import bundled image.');
        }

        return payload;
    }

    async function restorePaninoZipImages(zip, authStore) {
        const handledZipPaths = new Set();
        const metadataEntry = zip.file('_panino_metadata.json');
        if (!metadataEntry) {
            return { idMapping: new Map(), skippedItems: [], handledZipPaths };
        }

        let metadata;
        try {
            metadata = JSON.parse(await metadataEntry.async('string'));
        } catch {
            return {
                idMapping: new Map(),
                skippedItems: [createSkippedItem('_panino_metadata.json', 'invalid metadata file')],
                handledZipPaths,
            };
        }

        const bundledImages = Array.isArray(metadata?.images) ? metadata.images : [];
        for (const image of bundledImages) {
            const zipPath = normalizeZipEntryPath(image?.zipPath);
            if (zipPath) handledZipPaths.add(zipPath);
        }

        if (bundledImages.length === 0) {
            return { idMapping: new Map(), skippedItems: [], handledZipPaths };
        }

        if (!authStore.isAuthenticated || !authStore.token || !syncStore.isOnline) {
            return {
                idMapping: new Map(),
                skippedItems: [
                    createSkippedItem(
                        `${bundledImages.length} bundled image(s)`,
                        'bundled image restore requires an online signed-in session'
                    ),
                ],
                handledZipPaths,
            };
        }

        const idMapping = new Map();
        const skippedItems = [];

        for (const image of bundledImages) {
            const oldId = String(image?.id || '').trim();
            const zipPath = normalizeZipEntryPath(image?.zipPath);
            const filename = String(image?.filename || zipPath.split('/').pop() || `${oldId || 'imported-image'}.bin`);
            const mimeType = String(image?.mime_type || 'application/octet-stream');

            if (!oldId || !zipPath) {
                skippedItems.push(createSkippedItem(zipPath || filename, 'invalid image metadata'));
                continue;
            }

            const imageEntry = zip.file(zipPath);
            if (!imageEntry) {
                skippedItems.push(createSkippedItem(zipPath, 'bundled image missing from ZIP'));
                continue;
            }

            try {
                const data = await imageEntry.async('uint8array');
                const uploadBlob = new Blob([data], { type: mimeType });
                const payload = await uploadImportedImage(uploadBlob, filename, authStore.token);
                if (!payload?.id) {
                    throw new Error('Bundled image upload did not return an image id.');
                }
                idMapping.set(oldId, payload.id);
            } catch (error) {
                skippedItems.push(createSkippedItem(zipPath, error.message || 'failed to import bundled image'));
            }
        }

        return { idMapping, skippedItems, handledZipPaths };
    }

    async function findExistingFolder(parentId, name, folderLookupCache) {
        const cacheKey = buildFolderCacheKey(parentId, name);
        if (folderLookupCache.has(cacheKey)) {
            return folderLookupCache.get(cacheKey);
        }

        const rows = await syncStore.execute(
            'SELECT id, name, parent_id, created_at FROM folders WHERE parent_id IS ? AND name = ? LIMIT 1',
            [parentId ?? null, name]
        );
        const row = rows?.[0] || null;
        folderLookupCache.set(cacheKey, row);
        return row;
    }

    async function findExistingNote(folderId, title, noteLookupCache) {
        const cacheKey = buildNoteCacheKey(folderId, title);
        if (noteLookupCache.has(cacheKey)) {
            return noteLookupCache.get(cacheKey);
        }

        const rows = await syncStore.execute(
            'SELECT id, folder_id, title, content, created_at, updated_at FROM notes WHERE folder_id IS ? AND title = ? LIMIT 1',
            [folderId ?? null, title]
        );
        const row = rows?.[0] || null;
        noteLookupCache.set(cacheKey, row);
        return row;
    }

    async function resolveFolderPathId(folderPath, folderLookupCache, folderPathIdCache, options = {}) {
        const {
            createMissing = false,
            userId = null,
            createdAt = new Date().toISOString(),
            foldersCreatedRef = null,
        } = options;

        if (!folderPath) return null;
        if (folderPathIdCache.has(folderPath)) return folderPathIdCache.get(folderPath);

        const segments = folderPath.split('/').filter(Boolean);
        let parentId = null;
        let currentPath = null;

        for (const segment of segments) {
            currentPath = currentPath ? `${currentPath}/${segment}` : segment;
            if (folderPathIdCache.has(currentPath)) {
                parentId = folderPathIdCache.get(currentPath);
                if (parentId === null && !createMissing) return null;
                continue;
            }

            let folderRow = await findExistingFolder(parentId, segment, folderLookupCache);

            if (!folderRow && !createMissing) {
                folderPathIdCache.set(currentPath, null);
                return null;
            }

            if (!folderRow) {
                const folderId = uuidv4();
                await syncStore.db.value.exec(
                    'INSERT INTO folders (id, user_id, name, parent_id, created_at) VALUES (?, ?, ?, ?, ?)',
                    [folderId, userId, segment, parentId, createdAt]
                );
                folderRow = { id: folderId, name: segment, parent_id: parentId, created_at: createdAt };
                folderLookupCache.set(buildFolderCacheKey(parentId, segment), folderRow);
                if (foldersCreatedRef) foldersCreatedRef.count += 1;
            }

            folderPathIdCache.set(currentPath, folderRow.id);
            parentId = folderRow.id;
        }

        return parentId;
    }

    async function collectOverwriteCandidates(notes) {
        const folderLookupCache = new Map();
        const folderPathIdCache = new Map();
        const noteLookupCache = new Map();
        const overwriteCandidates = [];

        for (const note of notes) {
            const folderId = note.folderPath
                ? await resolveFolderPathId(note.folderPath, folderLookupCache, folderPathIdCache, { createMissing: false })
                : null;

            if (note.folderPath && !folderId) continue;

            const existingNote = await findExistingNote(folderId, note.title, noteLookupCache);
            if (!existingNote) continue;

            if ((existingNote.content || '') !== note.content) {
                overwriteCandidates.push(existingNote);
            }
        }

        return overwriteCandidates;
    }

    async function createRevisionSnapshot(noteId, token) {
        const endpoint = IS_PRODUCTION ? `/api/notes/${noteId}/revisions` : `${API_URL}/notes/${noteId}/revisions`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error || 'Failed to save a revision before import overwrite.');
        }
        return payload;
    }

    async function applyImportTree({ folderMap, notes, skippedItems = [] }, options = {}) {
        const { allowUnsafeOverwrite = false, onProgress = null } = options;
        const authStore = useAuthStore();
        const now = new Date().toISOString();

        const overwriteCandidates = await collectOverwriteCandidates(notes);
        const requiresGuaranteedRevisions = overwriteCandidates.length > 0;
        const canGuaranteeRevisions = Boolean(
            authStore.isAuthenticated && authStore.token && syncStore.isOnline && syncStore.syncEnabled
        );

        if (requiresGuaranteedRevisions && !canGuaranteeRevisions && !allowUnsafeOverwrite) {
            const error = new Error(
                `This import will overwrite ${overwriteCandidates.length} existing document(s). You are offline or revision capture is unavailable, so continuing may permanently replace the current content without a guaranteed restore path.`
            );
            error.code = 'UNSAFE_OVERWRITE';
            error.overwriteCount = overwriteCandidates.length;
            throw error;
        }

        if (requiresGuaranteedRevisions && canGuaranteeRevisions) {
            await syncStore.sync();
            for (const note of overwriteCandidates) {
                await createRevisionSnapshot(note.id, authStore.token);
            }
        }

        const folderLookupCache = new Map();
        const folderPathIdCache = new Map();
        const noteLookupCache = new Map();
        const foldersCreatedRef = { count: 0 };
        const result = {
            created: 0,
            updated: 0,
            unchanged: 0,
            foldersCreated: 0,
            skippedItems: [...skippedItems],
            overwriteCount: overwriteCandidates.length,
        };

        try {
            await syncStore.db.value.exec('BEGIN TRANSACTION;');

            const sortedFolderPaths = [...folderMap.keys()].sort((a, b) => a.split('/').length - b.split('/').length);
            for (const folderPath of sortedFolderPaths) {
                await resolveFolderPathId(folderPath, folderLookupCache, folderPathIdCache, {
                    createMissing: true,
                    userId: authStore.user.id,
                    createdAt: now,
                    foldersCreatedRef,
                });
            }

            for (let index = 0; index < notes.length; index++) {
                const note = notes[index];
                const folderId = note.folderPath
                    ? await resolveFolderPathId(note.folderPath, folderLookupCache, folderPathIdCache, {
                        createMissing: true,
                        userId: authStore.user.id,
                        createdAt: note.createdAt || now,
                        foldersCreatedRef,
                    })
                    : null;

                const existingNote = await findExistingNote(folderId, note.title, noteLookupCache);

                if (existingNote) {
                    if ((existingNote.content || '') === note.content) {
                        result.unchanged += 1;
                    } else {
                        const updatedAt = note.updatedAt || now;
                        await syncStore.db.value.exec(
                            'UPDATE notes SET content = ?, updated_at = ? WHERE id = ?',
                            [note.content, updatedAt, existingNote.id]
                        );
                        noteLookupCache.set(buildNoteCacheKey(folderId, note.title), {
                            ...existingNote,
                            content: note.content,
                            updated_at: updatedAt,
                        });
                        result.updated += 1;
                    }
                } else {
                    const noteId = uuidv4();
                    const createdAt = note.createdAt || now;
                    const updatedAt = note.updatedAt || createdAt;
                    await syncStore.db.value.exec(
                        'INSERT INTO notes (id, user_id, folder_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [noteId, authStore.user.id, folderId, note.title, note.content, createdAt, updatedAt]
                    );
                    noteLookupCache.set(buildNoteCacheKey(folderId, note.title), {
                        id: noteId,
                        folder_id: folderId,
                        title: note.title,
                        content: note.content,
                        created_at: createdAt,
                        updated_at: updatedAt,
                    });
                    result.created += 1;
                }

                if (onProgress) onProgress(index + 1, notes.length);
            }

            await syncStore.db.value.exec('COMMIT;');
        } catch (error) {
            await syncStore.db.value.exec('ROLLBACK;');
            throw error;
        }

        result.foldersCreated = foldersCreatedRef.count;
        await docStore.loadInitialData();
        return result;
    }

    async function buildMarkdownFileTree(files, { useRelativePath = false } = {}) {
        const fileArray = Array.from(files || []);
        const skippedItems = [];
        const entries = [];
        let totalBytes = 0;

        for (const file of fileArray) {
            const relativePath = useRelativePath ? (file.webkitRelativePath || file.name) : file.name;
            const sanitizedSegments = sanitizePathSegments(relativePath);

            if (!isMarkdownFile(relativePath)) {
                skippedItems.push(createSkippedItem(relativePath, 'unsupported file type'));
                continue;
            }

            if (sanitizedSegments.length === 0) {
                skippedItems.push(createSkippedItem(relativePath, 'invalid or empty path'));
                continue;
            }

            if (sanitizedSegments.some(isHiddenSegment)) {
                skippedItems.push(createSkippedItem(relativePath, 'hidden files and folders are not imported'));
                continue;
            }

            if (file.size > IMPORT_LIMITS.MAX_FILE_BYTES) {
                skippedItems.push(createSkippedItem(relativePath, 'larger than 1 MB'));
                continue;
            }

            totalBytes += file.size;
            entries.push({
                relativePath,
                content: await readFileAsText(file),
            });
        }

        if (entries.length === 0) {
            throw new Error('No importable .md files found.');
        }

        const tree = buildFolderTree(entries);
        validateImportLimits(tree.notes.length, tree.folders.size, totalBytes);
        return { ...tree, skippedItems };
    }

    async function getFileHandleAtPath(directoryHandle, segments) {
        let currentDirectory = directoryHandle;

        for (const segment of segments.slice(0, -1)) {
            currentDirectory = await currentDirectory.getDirectoryHandle(segment);
        }

        return currentDirectory.getFileHandle(segments[segments.length - 1]);
    }

    /**
     * List Markdown document handles inside a user-selected directory.
     *
     * @param {FileSystemDirectoryHandle} directoryHandle
     * @returns {Promise<Array<{handle: FileSystemFileHandle, path: string}>>}
     */
    async function listMarkdownDocumentsInDirectory(directoryHandle) {
        const documents = [];
        let fileCount = 0;
        let directoryCount = 0;

        async function visitDirectory(handle, parentPath = '') {
            for await (const [name, entry] of handle.entries()) {
                fileCount += 1;
                validateImportLimits(fileCount, directoryCount);

                if (isHiddenSegment(name)) continue;

                const path = parentPath ? `${parentPath}/${name}` : name;
                if (entry.kind === 'directory') {
                    directoryCount += 1;
                    validateImportLimits(fileCount, directoryCount);
                    await visitDirectory(entry, path);
                } else if (entry.kind === 'file' && isMarkdownFile(name)) {
                    documents.push({ handle: entry, path });
                }
            }
        }

        await visitDirectory(directoryHandle);
        return documents;
    }

    /**
     * Import one Markdown document and its locally-linked image files from a
     * directory explicitly granted by the user's browser picker.
     *
     * @param {FileSystemDirectoryHandle} directoryHandle
     * @param {{handle: FileSystemFileHandle, path: string}|FileSystemFileHandle} documentReference
     * @param {(current: number, total: number) => void|null} onProgress
     * @param {object} options
     * @returns {Promise<object>}
     */
    async function importDocumentWithLinkedImages(directoryHandle, documentReference, onProgress = null, options = {}) {
        const documentHandle = documentReference?.handle || documentReference;
        const documentPath = documentReference?.path || documentHandle?.name;
        if (!directoryHandle || !documentHandle) {
            throw new Error('Choose a source folder and a Markdown document to import.');
        }
        if (!isMarkdownFile(documentHandle.name)) {
            throw new Error('The selected document must be a .md file.');
        }

        const documentFile = await documentHandle.getFile();
        if (documentFile.size > IMPORT_LIMITS.MAX_FILE_BYTES) {
            throw new Error('The selected document is larger than 1 MB.');
        }

        const originalContent = await readFileAsText(documentFile);
        const imageReferences = collectLocalMarkdownImagePaths(originalContent);
        const skippedItems = [...imageReferences.skippedItems];
        const imageUrlByPath = new Map();
        const authStore = useAuthStore();
        const documentSegments = sanitizePathSegments(documentPath);
        const documentDirectorySegments = documentSegments.slice(0, -1);
        let totalBytes = documentFile.size;

        if (!authStore.isAuthenticated || !authStore.token || !syncStore.isOnline) {
            for (const path of imageReferences.paths) {
                skippedItems.push(createSkippedItem(path, 'linked image import requires an online signed-in session'));
            }
        } else {
            for (let index = 0; index < imageReferences.paths.length; index++) {
                const path = imageReferences.paths[index];
                const normalized = normalizeLocalImagePath(path);

                try {
                    const imageHandle = await getFileHandleAtPath(
                        directoryHandle,
                        [...documentDirectorySegments, ...normalized.segments]
                    );
                    const imageFile = await imageHandle.getFile();
                    if (imageFile.size > IMPORT_LIMITS.MAX_FILE_BYTES) {
                        skippedItems.push(createSkippedItem(path, 'larger than 1 MB'));
                        continue;
                    }

                    totalBytes += imageFile.size;
                    validateImportLimits(index + 2, 0, totalBytes);
                    const payload = await uploadImportedImage(imageFile, imageFile.name, authStore.token);
                    if (!payload?.id) {
                        throw new Error('image upload did not return an image id');
                    }
                    imageUrlByPath.set(path, buildImageUrl(payload.id));
                } catch (error) {
                    skippedItems.push(createSkippedItem(path, error.message || 'failed to import linked image'));
                } finally {
                    if (onProgress) onProgress(index + 1, imageReferences.paths.length);
                }
            }
        }

        const tree = {
            folderMap: new Map(),
            notes: [{
                title: extractTitleFromFrontMatter(originalContent) || titleFromFilename(documentFile.name),
                content: replaceLocalMarkdownImageReferences(originalContent, imageUrlByPath),
                folderPath: null,
            }],
            skippedItems,
        };

        const result = await applyImportTree(tree, { ...options, onProgress: null });
        result.imagesImported = imageUrlByPath.size;
        return result;
    }

    async function buildZipImportTree(file) {
        const zip = await JSZip.loadAsync(file);
        const authStore = useAuthStore();
        const {
            idMapping: bundledImageIdMapping,
            skippedItems: bundledImageSkippedItems,
            handledZipPaths,
        } = await restorePaninoZipImages(zip, authStore);
        const skippedItems = [...bundledImageSkippedItems];
        const entries = [];
        const folderMap = new Map();
        let totalBytes = 0;

        const zipEntries = Object.keys(zip.files);
        let fileCount = 0;
        let dirCount = 0;

        for (const path of zipEntries) {
            if (zip.files[path].dir) dirCount += 1;
            else fileCount += 1;
        }

        validateImportLimits(fileCount, dirCount);

        for (const path of zipEntries) {
            const zipEntry = zip.files[path];
            const normalizedPath = path.replace(/\\/g, '/');
            const segments = sanitizePathSegments(normalizedPath);

            if (zipEntry.dir) {
                if (normalizedPath === '_images/' || normalizedPath === '_images') {
                    continue;
                }
                if (segments.length === 0 || segments.some(isHiddenSegment)) {
                    if (normalizedPath) {
                        skippedItems.push(createSkippedItem(normalizedPath, 'hidden or invalid folder path'));
                    }
                    continue;
                }
                addFolderPathToMap(folderMap, segments.join('/'));
                continue;
            }

            if (normalizedPath === '_panino_metadata.json') {
                continue;
            }

            if (normalizedPath.startsWith('_images/')) {
                if (!handledZipPaths.has(normalizedPath)) {
                    skippedItems.push(createSkippedItem(normalizedPath, 'unsupported file type'));
                }
                continue;
            }

            if (!isMarkdownFile(normalizedPath)) {
                skippedItems.push(createSkippedItem(normalizedPath, 'unsupported file type'));
                continue;
            }

            if (segments.length === 0 || segments.some(isHiddenSegment)) {
                skippedItems.push(createSkippedItem(normalizedPath, 'hidden or invalid path'));
                continue;
            }

            const data = await zipEntry.async('uint8array');
            if (data.length > IMPORT_LIMITS.MAX_FILE_BYTES) {
                skippedItems.push(createSkippedItem(normalizedPath, 'larger than 1 MB'));
                continue;
            }

            totalBytes += data.length;
            const content = new TextDecoder('utf-8').decode(data);
            entries.push({
                relativePath: normalizedPath,
                content: replaceImageReferences(content, bundledImageIdMapping, buildImageUrl),
            });
        }

        if (entries.length === 0 && folderMap.size === 0) {
            throw new Error('No importable .md files found in the ZIP archive.');
        }

        const derivedTree = buildFolderTree(entries);
        for (const folderPath of derivedTree.folders.keys()) {
            addFolderPathToMap(folderMap, folderPath);
        }

        validateImportLimits(derivedTree.notes.length, folderMap.size, totalBytes);
        return {
            folderMap,
            notes: derivedTree.notes,
            skippedItems,
        };
    }

    // ─── JSON export ─────────────────────────────────────────

    /**
     * Exports all user data (folders, notes, images, settings, globals)
     * from the local SQLite DB into a JSON string.
     */
    async function exportDataAsJsonString() {
        if (!syncStore.isInitialized) throw new Error('Sync not ready.');
        const authStore = useAuthStore();
        const { folders, notes, images, settings, globals } = await queryAllData();

        let imageData = [];
        if (authStore.isAuthenticated && images.length) {
            imageData = await fetchAllImageData(images, authStore.token);
        }

        const data = {
            version: 2,
            folders,
            notes,
            images: imageData,
            settings,
            globals,
        };

        return JSON.stringify(data, null, 2);
    }

    // ─── ZIP export ──────────────────────────────────────────

    /**
     * Exports all user data into a ZIP archive with a proper folder structure,
     * plus an `_images/` directory and `_panino_metadata.json` for settings/globals.
     */
    async function exportDataAsZip() {
        if (!syncStore.isInitialized) throw new Error('Sync not ready.');
        const authStore = useAuthStore();

        const zip = new JSZip();

        const { folders, notes, images, settings, globals } = await queryAllData();

        const folderMap = new Map(folders.map(f => [f.id, f]));

        // Create a path for each folder and note
        const paths = new Map();
        function getPath(itemId, isFolder) {
            if (paths.has(itemId)) return paths.get(itemId);

            const item = isFolder ? folderMap.get(itemId) : notes.find(n => n.id === itemId);
            if (!item) return '';

            // Sanitize names to prevent invalid paths
            const saneName = (item.name || item.title || "Untitled").replace(/[/\\?%*:|"<>]/g, '_');

            const parentId = isFolder ? item.parent_id : item.folder_id;
            if (!parentId) {
                paths.set(itemId, saneName);
                return saneName;
            }

            const parentPath = getPath(parentId, true);
            const path = `${parentPath}/${saneName}`;
            paths.set(itemId, path);
            return path;
        }

        // Add folders to zip
        for (const folder of folders) {
            const path = getPath(folder.id, true);
            if (path) {
                zip.folder(path);
            }
        }

        // Add notes to zip
        for (const note of notes) {
            const path = getPath(note.id, false);
            if (path) {
                zip.file(`${path}.md`, note.content || '');
            }
        }

        // Add images to zip
        const imageMetadata = [];
        if (authStore.isAuthenticated && images.length) {
            const imgFolder = zip.folder('_images');
            for (const img of images) {
                try {
                    const url = buildImageUrl(img.id);
                    const response = await fetch(url, {
                        headers: { 'Authorization': `Bearer ${authStore.token}` }
                    });
                    if (!response.ok) continue;
                    const blob = await response.blob();
                    const ext = (img.filename || '').split('.').pop() || 'bin';
                    const zipFilename = `${img.id}.${ext}`;
                    imgFolder.file(zipFilename, blob);
                    imageMetadata.push({
                        id: img.id,
                        filename: img.filename,
                        mime_type: img.mime_type,
                        created_at: img.created_at,
                        zipPath: `_images/${zipFilename}`,
                    });
                } catch (err) {
                    console.warn(`[export] Failed to fetch image ${img.id} for ZIP:`, err);
                }
            }
        }

        // Add metadata file
        zip.file('_panino_metadata.json', JSON.stringify({
            version: 2,
            settings,
            globals,
            images: imageMetadata,
        }, null, 2));

        const blob = await zip.generateAsync({ type: 'blob' });
        saveAs(blob, 'panino-export.zip');
    }

    // ─── StackEdit export ────────────────────────────────────

    /**
     * Exports all user data into a StackEdit-compatible JSON string.
     */
    async function exportDataAsStackEditJsonString() {
        if (!syncStore.isInitialized) throw new Error('Sync not ready.');

        const folders = await syncStore.execute('SELECT * FROM folders');
        const notes = await syncStore.execute('SELECT * FROM notes');

        const stackEditData = {};
        const now = Date.now();

        // Add folders
        (folders || []).forEach(folder => {
            stackEditData[folder.id] = {
                id: folder.id,
                type: 'folder',
                name: folder.name,
                parentId: folder.parent_id,
                hash: now,
                tx: now,
            };
        });

        // Add files and their content
        (notes || []).forEach(note => {
            // File entry
            stackEditData[note.id] = {
                id: note.id,
                type: 'file',
                name: note.title,
                parentId: note.folder_id,
                hash: now,
                tx: now,
            };
            // Content entry
            stackEditData[`${note.id}/content`] = {
                id: `${note.id}/content`,
                type: 'content',
                text: note.content || '',
                properties: '\n', // Default value from example
                discussions: {},
                comments: {},
                hash: now,
                tx: now,
            };
        });

        return JSON.stringify(stackEditData, null, 2);
    }

    // ─── JSON import ─────────────────────────────────────────

    /**
     * Imports folders and markdown documents from a Panino JSON object.
     * Images, settings, and globals are not imported.
     */
    async function importData(data, options = {}) {
        if (!syncStore.isInitialized) throw new Error('Sync not ready.');
        const authStore = useAuthStore();
        if (!authStore.user?.id) throw new Error('User is not authenticated for import.');

        if (!data || !Array.isArray(data.folders) || !Array.isArray(data.notes)) {
            throw new Error('Invalid import data format. Expected { folders: [], notes: [] }');
        }

        const tree = buildImportTreeFromStructuredData(data.folders, data.notes, {
            folderIdKey: 'id',
            folderNameKey: 'name',
            folderParentIdKey: 'parent_id',
            noteFolderIdKey: 'folder_id',
            noteTitleKey: 'title',
            noteContentKey: 'content',
            noteCreatedAtKey: 'created_at',
            noteUpdatedAtKey: 'updated_at',
        });

        if (Array.isArray(data.images) && data.images.length > 0) {
            tree.skippedItems.push(createSkippedItem(`${data.images.length} image record(s)`, 'image imports are not supported'));
        }
        if (Array.isArray(data.settings) && data.settings.length > 0) {
            tree.skippedItems.push(createSkippedItem(`${data.settings.length} setting record(s)`, 'settings imports are not supported'));
        }
        if (Array.isArray(data.globals) && data.globals.length > 0) {
            tree.skippedItems.push(createSkippedItem(`${data.globals.length} variable record(s)`, 'global variable imports are not supported'));
        }

        return applyImportTree(tree, options);
    }

    // ─── StackEdit import ────────────────────────────────────

    /**
     * Imports folders and markdown documents from a StackEdit JSON object.
     */
    async function importStackEditData(data, options = {}) {
        if (!syncStore.isInitialized) throw new Error('Sync not ready.');
        if (typeof data !== 'object' || data === null) {
            throw new Error('Invalid import data format. Expected a JSON object.');
        }

        const authStore = useAuthStore();
        if (!authStore.user?.id) throw new Error('User is not authenticated for import.');

        const folders = [];
        const files = [];
        const contents = new Map();

        for (const key of Object.keys(data)) {
            const item = data[key];
            if (item?.type === 'folder') {
                folders.push(item);
            } else if (item?.type === 'file') {
                files.push(item);
            } else if (item?.type === 'content') {
                contents.set(key.split('/')[0], item.text || '');
            }
        }

        const noteRows = files.map(file => ({
            folder_id: file.parentId || null,
            title: file.name,
            content: contents.get(file.id) || '',
            created_at: new Date(file.tx || Date.now()).toISOString(),
            updated_at: new Date(file.tx || Date.now()).toISOString(),
        }));

        const tree = buildImportTreeFromStructuredData(folders, noteRows, {
            folderIdKey: 'id',
            folderNameKey: 'name',
            folderParentIdKey: 'parentId',
            noteFolderIdKey: 'folder_id',
            noteTitleKey: 'title',
            noteContentKey: 'content',
            noteCreatedAtKey: 'created_at',
            noteUpdatedAtKey: 'updated_at',
        });

        return applyImportTree(tree, options);
    }

    // ─── Markdown file import ────────────────────────────────

    /**
     * Import one or more markdown files into the root folder.
     * Matching documents are updated in place.
     */
    async function importMarkdownFiles(files, targetFolderId = null, onProgress = null, options = {}) {
        if (targetFolderId) {
            throw new Error('Importing markdown files into a specific destination folder is not supported by this import mode.');
        }

        const tree = await buildMarkdownFileTree(files, { useRelativePath: false });
        return applyImportTree(tree, { ...options, onProgress });
    }

    /**
     * Import a directory of markdown files, preserving folder structure.
     * Matching documents are updated in place.
     */
    async function importMarkdownDirectory(files, onProgress = null, options = {}) {
        const tree = await buildMarkdownFileTree(files, { useRelativePath: true });
        return applyImportTree(tree, { ...options, onProgress });
    }

    /**
     * Import a ZIP archive containing folders and .md files.
     * Matching documents are updated in place.
     */
    async function importZipArchive(file, onProgress = null, options = {}) {
        const tree = await buildZipImportTree(file);
        return applyImportTree(tree, { ...options, onProgress });
    }

    return {
        exportDataAsJsonString,
        exportDataAsZip,
        importData,
        exportDataAsStackEditJsonString,
        importStackEditData,
        importMarkdownFiles,
        importMarkdownDirectory,
        listMarkdownDocumentsInDirectory,
        importDocumentWithLinkedImages,
        importZipArchive,
    };
});
