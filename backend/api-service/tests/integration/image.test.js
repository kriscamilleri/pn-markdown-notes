import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { createTestApp, setupTestUser, cleanupTestUser, getTestToken } from '../testHelpers.js';
import { deleteTestDb, getDb, getSpacesDb, getUserDb } from '../../db.js';
import { pruneOrphanImagesForDb, pruneOrphanImagesForUser, runDailyImageOrphanPrune, startImageOrphanPruneJob } from '../../image.js';
import { addEditorMember, createSpace } from '../../spaces.js';
import { deleteSpaceUploads, resolveSpaceUploadRoot } from '../../spaceStorage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const ORIGINAL_SHARED_SPACES_FLAG = process.env.SHARED_SPACES_ENABLED;

const TEST_PNG_BUFFER = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
    0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
]);

function createFixtureFiles() {
    if (!fs.existsSync(FIXTURES_DIR)) {
        fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    }

    fs.writeFileSync(path.join(FIXTURES_DIR, 'test-image.png'), TEST_PNG_BUFFER);
    fs.writeFileSync(path.join(FIXTURES_DIR, 'test-image.jpg'), TEST_PNG_BUFFER);
    fs.writeFileSync(path.join(FIXTURES_DIR, 'test-image.gif'), TEST_PNG_BUFFER);
    fs.writeFileSync(path.join(FIXTURES_DIR, 'test-image.webp'), TEST_PNG_BUFFER);
    fs.writeFileSync(path.join(FIXTURES_DIR, 'test-image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    fs.writeFileSync(path.join(FIXTURES_DIR, 'test.txt'), 'not an image');
    fs.writeFileSync(path.join(FIXTURES_DIR, 'large-image.png'), Buffer.alloc(2 * 1024 * 1024, 1));
}

function removeFixtureFiles() {
    const names = ['test-image.png', 'test-image.jpg', 'test-image.gif', 'test-image.webp', 'test-image.svg', 'test.txt', 'large-image.png'];
    names.forEach((name) => {
        const filePath = path.join(FIXTURES_DIR, name);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    });
}

function listImagePathsForUser(userId) {
    const db = getUserDb(userId);
    const rows = db.prepare('SELECT path FROM images').all();
    return rows.map((row) => path.join(UPLOADS_DIR, row.path));
}

function cleanupUploadedFiles(userId) {
    const files = listImagePathsForUser(userId);
    files.forEach((filePath) => {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    });
}

function insertImageRecord(userId, values) {
    const db = getUserDb(userId);
    db.prepare(`
        INSERT INTO images (id, user_id, filename, mime_type, path, size_bytes, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        values.id,
        userId,
        values.filename,
        values.mimeType,
        values.path,
        values.sizeBytes || 0,
        values.sha256 || '',
        values.createdAt || new Date().toISOString(),
    );
}

function insertNoteRecord(userId, values) {
    const db = getUserDb(userId);
    db.prepare(`
        INSERT INTO notes (id, user_id, folder_id, title, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        values.id,
        userId,
        values.folderId || null,
        values.title || 'Untitled',
        values.content || '',
        values.createdAt || new Date().toISOString(),
        values.updatedAt || new Date().toISOString(),
    );
}

describe('Image management API', () => {
    let app;
    let server;
    let user;
    let otherUser;
    let spaceIds;

    beforeAll(() => {
        const result = createTestApp();
        app = result.app;
        server = result.server;
        createFixtureFiles();
    });

    beforeEach(async () => {
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        user = await setupTestUser(`image-user-${suffix}@example.com`, 'password123');
        otherUser = await setupTestUser(`image-other-${suffix}@example.com`, 'password123');
        spaceIds = [];
    });

    afterEach(() => {
        const spacesDb = getSpacesDb();
        for (const spaceId of spaceIds) {
            spacesDb.prepare('DELETE FROM space_invites WHERE space_id = ?').run(spaceId);
            spacesDb.prepare('DELETE FROM space_members WHERE space_id = ?').run(spaceId);
            spacesDb.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId);
            deleteTestDb(`space:${spaceId}`);
            deleteSpaceUploads(spaceId);
        }
        if (user) {
            cleanupUploadedFiles(user.userId);
            cleanupTestUser(user.userId);
        }
        if (otherUser) {
            cleanupUploadedFiles(otherUser.userId);
            cleanupTestUser(otherUser.userId);
        }
        if (ORIGINAL_SHARED_SPACES_FLAG === undefined) delete process.env.SHARED_SPACES_ENABLED;
        else process.env.SHARED_SPACES_ENABLED = ORIGINAL_SHARED_SPACES_FLAG;
    });

    afterAll(() => {
        removeFixtureFiles();
        return new Promise((resolve) => {
            if (server) {
                server.close(() => resolve());
            } else {
                resolve();
            }
        });
    });

    function createTestSpace(owner = user, editor = otherUser) {
        process.env.SHARED_SPACES_ENABLED = 'true';
        const space = createSpace({ actorUserId: owner.userId, name: 'Image space' });
        spaceIds.push(space.spaceId);
        if (editor) {
            addEditorMember({
                actorUserId: owner.userId,
                spaceId: space.spaceId,
                userId: editor.userId,
                role: 'editor',
            });
        }
        return space;
    }

    it('uploads allowlisted image types and captures size/sha metadata', async () => {
        const token = getTestToken(user.userId);
        const pngPath = path.join(FIXTURES_DIR, 'test-image.png');

        const response = await request(app)
            .post('/images')
            .set('Authorization', `Bearer ${token}`)
            .attach('image', pngPath);

        expect(response.status).toBe(201);
        expect(response.body.url).toContain('/images/');

        const db = getUserDb(user.userId);
        const image = db.prepare('SELECT * FROM images WHERE id = ?').get(response.body.id);

        expect(image).toBeDefined();
        expect(image.size_bytes).toBe(TEST_PNG_BUFFER.length);
        expect(image.sha256).toBe(crypto.createHash('sha256').update(TEST_PNG_BUFFER).digest('hex'));
    });

    it('rejects non-allowlisted MIME types', async () => {
        const token = getTestToken(user.userId);

        const response = await request(app)
            .post('/images')
            .set('Authorization', `Bearer ${token}`)
            .attach('image', path.join(FIXTURES_DIR, 'test.txt'));

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('Unsupported image type');
    });

    it('rejects extension and MIME mismatch', async () => {
        const token = getTestToken(user.userId);

        const response = await request(app)
            .post('/images')
            .set('Authorization', `Bearer ${token}`)
            .attach('image', path.join(FIXTURES_DIR, 'test-image.png'), {
                filename: 'mismatch.jpg',
                contentType: 'image/png',
            });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('File extension does not match MIME type');
    });

    it('rejects uploads larger than 1MB', async () => {
        const token = getTestToken(user.userId);

        const response = await request(app)
            .post('/images')
            .set('Authorization', `Bearer ${token}`)
            .attach('image', path.join(FIXTURES_DIR, 'large-image.png'));

        expect(response.status).toBe(413);
        expect(response.body.error).toContain('1MB');
    });

    it('lists images with deterministic search and sort', async () => {
        getUserDb(user.userId);
        insertImageRecord(user.userId, {
            id: 'img-a',
            filename: 'alpha.png',
            mimeType: 'image/png',
            path: 'alpha.png',
            sizeBytes: 10,
            createdAt: '2026-02-10T10:00:00.000Z',
        });
        insertImageRecord(user.userId, {
            id: 'img-b',
            filename: 'beta.png',
            mimeType: 'image/png',
            path: 'beta.png',
            sizeBytes: 50,
            createdAt: '2026-02-11T10:00:00.000Z',
        });
        insertImageRecord(otherUser.userId, {
            id: 'img-other',
            filename: 'other.png',
            mimeType: 'image/png',
            path: 'other.png',
            sizeBytes: 500,
            createdAt: '2026-02-12T10:00:00.000Z',
        });

        const token = getTestToken(user.userId);
        const response = await request(app)
            .get('/images?search=a&sort=size_desc&limit=50')
            .set('Authorization', `Bearer ${token}`);

        expect(response.status).toBe(200);
        expect(response.body.images.map((img) => img.id)).toEqual(['img-b', 'img-a']);
        expect(response.body.images.every((img) => img.id !== 'img-other')).toBe(true);

        const first = response.body.images[0];
        expect(first).toHaveProperty('sizeBytes');
        expect(first).toHaveProperty('usageCount');
    });

    it('supports cursor pagination for image listing', async () => {
        insertImageRecord(user.userId, {
            id: 'img-1',
            filename: '1.png',
            mimeType: 'image/png',
            path: '1.png',
            sizeBytes: 1,
            createdAt: '2026-02-01T00:00:00.000Z',
        });
        insertImageRecord(user.userId, {
            id: 'img-2',
            filename: '2.png',
            mimeType: 'image/png',
            path: '2.png',
            sizeBytes: 2,
            createdAt: '2026-02-02T00:00:00.000Z',
        });
        insertImageRecord(user.userId, {
            id: 'img-3',
            filename: '3.png',
            mimeType: 'image/png',
            path: '3.png',
            sizeBytes: 3,
            createdAt: '2026-02-03T00:00:00.000Z',
        });

        const token = getTestToken(user.userId);
        const firstPage = await request(app)
            .get('/images?sort=created_desc&limit=2')
            .set('Authorization', `Bearer ${token}`);

        expect(firstPage.status).toBe(200);
        expect(firstPage.body.images).toHaveLength(2);
        expect(firstPage.body.nextCursor).toBeTruthy();

        const secondPage = await request(app)
            .get(`/images?sort=created_desc&limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
            .set('Authorization', `Bearer ${token}`);

        expect(secondPage.status).toBe(200);
        expect(secondPage.body.images).toHaveLength(1);
        expect(secondPage.body.images[0].id).toBe('img-1');
    });

    it('detects usage from /images/:id and /api/images/:id patterns', async () => {
        insertImageRecord(user.userId, {
            id: 'img-usage',
            filename: 'usage.png',
            mimeType: 'image/png',
            path: 'usage.png',
            sizeBytes: 10,
        });

        insertNoteRecord(user.userId, {
            id: 'note-1',
            title: 'Note one',
            content: '![a](/images/img-usage)',
            updatedAt: '2026-02-17T09:00:00.000Z',
        });
        insertNoteRecord(user.userId, {
            id: 'note-2',
            title: 'Note two',
            content: '![b](/api/images/img-usage)',
            updatedAt: '2026-02-17T10:00:00.000Z',
        });

        const token = getTestToken(user.userId);
        const response = await request(app)
            .get('/images/img-usage/usage')
            .set('Authorization', `Bearer ${token}`);

        expect(response.status).toBe(200);
        expect(response.body.usage.count).toBe(2);
        expect(response.body.usage.notes.map((note) => note.id)).toEqual(['note-2', 'note-1']);
    });

    it('deletes unused image metadata and disk file', async () => {
        const token = getTestToken(user.userId);
        const uploadResponse = await request(app)
            .post('/images')
            .set('Authorization', `Bearer ${token}`)
            .attach('image', path.join(FIXTURES_DIR, 'test-image.png'));

        const db = getUserDb(user.userId);
        const image = db.prepare('SELECT path FROM images WHERE id = ?').get(uploadResponse.body.id);
        const diskPath = path.join(UPLOADS_DIR, image.path);

        const response = await request(app)
            .delete(`/images/${uploadResponse.body.id}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ force: false });

        expect(response.status).toBe(200);
        expect(db.prepare('SELECT id FROM images WHERE id = ?').get(uploadResponse.body.id)).toBeUndefined();
        expect(fs.existsSync(diskPath)).toBe(false);
    });

    it('returns 409 for in-use image when force is false', async () => {
        insertImageRecord(user.userId, {
            id: 'img-in-use',
            filename: 'in-use.png',
            mimeType: 'image/png',
            path: 'in-use.png',
            sizeBytes: 10,
        });
        insertNoteRecord(user.userId, {
            id: 'note-in-use',
            content: '![x](/images/img-in-use)',
        });

        const token = getTestToken(user.userId);
        const response = await request(app)
            .delete('/images/img-in-use')
            .set('Authorization', `Bearer ${token}`)
            .send({ force: false });

        expect(response.status).toBe(409);
        expect(response.body.usage.count).toBe(1);
    });

    it('forced delete succeeds even for referenced image', async () => {
        insertImageRecord(user.userId, {
            id: 'img-force',
            filename: 'force.png',
            mimeType: 'image/png',
            path: 'force.png',
            sizeBytes: 10,
        });
        insertNoteRecord(user.userId, {
            id: 'note-force',
            content: '![x](/api/images/img-force)',
        });

        const token = getTestToken(user.userId);
        const response = await request(app)
            .delete('/images/img-force')
            .set('Authorization', `Bearer ${token}`)
            .send({ force: true });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ deleted: true, id: 'img-force' });
    });

    it('delete tolerates missing file on disk', async () => {
        const token = getTestToken(user.userId);
        const uploadResponse = await request(app)
            .post('/images')
            .set('Authorization', `Bearer ${token}`)
            .attach('image', path.join(FIXTURES_DIR, 'test-image.png'));

        const db = getUserDb(user.userId);
        const image = db.prepare('SELECT path FROM images WHERE id = ?').get(uploadResponse.body.id);
        const diskPath = path.join(UPLOADS_DIR, image.path);
        fs.unlinkSync(diskPath);

        const response = await request(app)
            .delete(`/images/${uploadResponse.body.id}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ force: false });

        expect(response.status).toBe(200);
        expect(db.prepare('SELECT id FROM images WHERE id = ?').get(uploadResponse.body.id)).toBeUndefined();
    });

    it('bulk delete returns mixed per-item results', async () => {
        insertImageRecord(user.userId, {
            id: 'img-bulk-1',
            filename: 'bulk-1.png',
            mimeType: 'image/png',
            path: 'bulk-1.png',
            sizeBytes: 10,
        });
        insertImageRecord(user.userId, {
            id: 'img-bulk-2',
            filename: 'bulk-2.png',
            mimeType: 'image/png',
            path: 'bulk-2.png',
            sizeBytes: 10,
        });
        insertNoteRecord(user.userId, {
            id: 'note-bulk',
            content: '![x](/images/img-bulk-2)',
        });

        const token = getTestToken(user.userId);
        const response = await request(app)
            .post('/images/bulk-delete')
            .set('Authorization', `Bearer ${token}`)
            .send({ ids: ['img-bulk-1', 'img-bulk-2'], force: false });

        expect(response.status).toBe(200);
        expect(response.body.results).toEqual([
            { id: 'img-bulk-1', deleted: true },
            { id: 'img-bulk-2', deleted: false, reason: 'in-use', usageCount: 1 },
        ]);
    });

    it('returns per-user image stats', async () => {
        insertImageRecord(user.userId, {
            id: 'img-stat-1',
            filename: 'stat-1.png',
            mimeType: 'image/png',
            path: 'stat-1.png',
            sizeBytes: 40,
        });
        insertImageRecord(user.userId, {
            id: 'img-stat-2',
            filename: 'stat-2.png',
            mimeType: 'image/png',
            path: 'stat-2.png',
            sizeBytes: 60,
        });

        const token = getTestToken(user.userId);
        const response = await request(app)
            .get('/images/stats')
            .set('Authorization', `Bearer ${token}`);

        expect(response.status).toBe(200);
        expect(response.body.imageCount).toBe(2);
        expect(response.body.totalImageBytes).toBe(100);
        expect(response.body).toHaveProperty('quotaBytes');
    });

    it('rejects unauthorized image list requests', async () => {
        const response = await request(app).get('/images');
        expect(response.status).toBe(401);
    });

    it('prevents cross-user access to another user image id', async () => {
        const ownerToken = getTestToken(user.userId);
        const otherToken = getTestToken(otherUser.userId);

        const uploadResponse = await request(app)
            .post('/images')
            .set('Authorization', `Bearer ${ownerToken}`)
            .attach('image', path.join(FIXTURES_DIR, 'test-image.png'));

        expect(uploadResponse.status).toBe(201);
        const imageId = uploadResponse.body.id;

        const usageResponse = await request(app)
            .get(`/images/${imageId}/usage`)
            .set('Authorization', `Bearer ${otherToken}`);
        expect(usageResponse.status).toBe(404);

        const readResponse = await request(app)
            .get(`/images/${imageId}`)
            .set('Authorization', `Bearer ${otherToken}`);
        expect(readResponse.status).toBe(404);

        const deleteResponse = await request(app)
            .delete(`/images/${imageId}`)
            .set('Authorization', `Bearer ${otherToken}`)
            .send({ force: true });
        expect(deleteResponse.status).toBe(404);
    });

    it('accepts and stores non-standard filenames', async () => {
        const token = getTestToken(user.userId);
        const weirdFilename = 'réport 2026_%! ✅.PNG';

        const response = await request(app)
            .post('/images')
            .set('Authorization', `Bearer ${token}`)
            .attach('image', path.join(FIXTURES_DIR, 'test-image.png'), {
                filename: weirdFilename,
                contentType: 'image/png',
            });

        expect(response.status).toBe(201);

        const db = getUserDb(user.userId);
        const row = db.prepare('SELECT filename, mime_type FROM images WHERE id = ?').get(response.body.id);
        expect(row.filename).toBe(weirdFilename);
        expect(row.mime_type).toBe('image/png');
    });

    it('search treats % and _ as literal filename characters', async () => {
        insertImageRecord(user.userId, {
            id: 'img-search-literal',
            filename: '100%_done.png',
            mimeType: 'image/png',
            path: 'literal.png',
            sizeBytes: 10,
            createdAt: '2026-02-10T10:00:00.000Z',
        });
        insertImageRecord(user.userId, {
            id: 'img-search-wild',
            filename: '100x_done.png',
            mimeType: 'image/png',
            path: 'wild.png',
            sizeBytes: 10,
            createdAt: '2026-02-10T10:00:01.000Z',
        });

        const token = getTestToken(user.userId);
        const response = await request(app)
            .get('/images?search=%25_&sort=created_asc&limit=50')
            .set('Authorization', `Bearer ${token}`);

        expect(response.status).toBe(200);
        expect(response.body.images.map((img) => img.id)).toEqual(['img-search-literal']);
    });

    it('blocks path traversal in image reads and deletes', async () => {
        insertImageRecord(user.userId, {
            id: 'img-malicious',
            filename: 'malicious.png',
            mimeType: 'image/png',
            path: '../../package.json',
            sizeBytes: 1,
        });

        const token = getTestToken(user.userId);

        const getResponse = await request(app)
            .get('/images/img-malicious')
            .set('Authorization', `Bearer ${token}`);
        expect(getResponse.status).toBe(403);

        const deleteResponse = await request(app)
            .delete('/images/img-malicious')
            .set('Authorization', `Bearer ${token}`)
            .send({ force: true });
        expect(deleteResponse.status).toBe(403);

        insertImageRecord(user.userId, {
            id: 'img-space-subtree',
            filename: 'space-subtree.png',
            mimeType: 'image/png',
            path: 'spaces/22222222-2222-4222-8222-222222222222/private.png',
            sizeBytes: 1,
        });
        await request(app)
            .get('/images/img-space-subtree')
            .set('Authorization', `Bearer ${token}`)
            .expect(403);
        await request(app)
            .delete('/images/img-space-subtree')
            .set('Authorization', `Bearer ${token}`)
            .send({ force: true })
            .expect(403);
    });

    it('prunes only unreferenced old images with bounded batch behavior', () => {
        const oldDate = '2026-01-01T00:00:00.000Z';
        const recentDate = new Date().toISOString();

        insertImageRecord(user.userId, {
            id: 'img-prune-old-unused',
            filename: 'old-unused.png',
            mimeType: 'image/png',
            path: 'old-unused.png',
            sizeBytes: 10,
            createdAt: oldDate,
        });
        insertImageRecord(user.userId, {
            id: 'img-prune-old-used',
            filename: 'old-used.png',
            mimeType: 'image/png',
            path: 'old-used.png',
            sizeBytes: 10,
            createdAt: oldDate,
        });
        insertImageRecord(user.userId, {
            id: 'img-prune-recent-unused',
            filename: 'recent-unused.png',
            mimeType: 'image/png',
            path: 'recent-unused.png',
            sizeBytes: 10,
            createdAt: recentDate,
        });

        insertNoteRecord(user.userId, {
            id: 'note-prune',
            content: '![x](/images/img-prune-old-used)',
        });

        const deleted = pruneOrphanImagesForUser(user.userId, { maxDeletes: 1, olderThanDays: 7 });
        expect(deleted).toBe(1);

        const db = getUserDb(user.userId);
        expect(db.prepare('SELECT id FROM images WHERE id = ?').get('img-prune-old-unused')).toBeUndefined();
        expect(db.prepare('SELECT id FROM images WHERE id = ?').get('img-prune-old-used')).toBeDefined();
        expect(db.prepare('SELECT id FROM images WHERE id = ?').get('img-prune-recent-unused')).toBeDefined();
    });

    it('runs daily prune across all users and sums deletions', () => {
        const oldDate = '2026-01-01T00:00:00.000Z';

        insertImageRecord(user.userId, {
            id: 'img-user-a-old-unused',
            filename: 'a-old-unused.png',
            mimeType: 'image/png',
            path: 'a-old-unused.png',
            sizeBytes: 10,
            createdAt: oldDate,
        });

        insertImageRecord(otherUser.userId, {
            id: 'img-user-b-old-unused',
            filename: 'b-old-unused.png',
            mimeType: 'image/png',
            path: 'b-old-unused.png',
            sizeBytes: 10,
            createdAt: oldDate,
        });

        const totalDeleted = runDailyImageOrphanPrune();
        expect(totalDeleted).toBeGreaterThanOrEqual(2);

        const userDb = getUserDb(user.userId);
        const otherDb = getUserDb(otherUser.userId);
        expect(userDb.prepare('SELECT id FROM images WHERE id = ?').get('img-user-a-old-unused')).toBeUndefined();
        expect(otherDb.prepare('SELECT id FROM images WHERE id = ?').get('img-user-b-old-unused')).toBeUndefined();
    });

    it('uploads, lists, serves, reports usage, and deletes images through a qualified space target', async () => {
        const space = createTestSpace();
        const spaceId = space.spaceId;
        const editorToken = getTestToken(otherUser.userId);
        const ownerToken = getTestToken(user.userId);

        const uploadResponse = await request(app)
            .post(`/images?space=${spaceId}`)
            .set('Authorization', `Bearer ${editorToken}`)
            .attach('image', path.join(FIXTURES_DIR, 'test-image.png'));

        expect(uploadResponse.status).toBe(201);
        expect(uploadResponse.headers['cache-control']).toBe('private, no-store');
        expect(uploadResponse.body.url).toBe(`/images/${uploadResponse.body.id}?space=${spaceId}`);

        const db = getDb(`space:${spaceId}`);
        const stored = db.prepare('SELECT * FROM images WHERE id = ?').get(uploadResponse.body.id);
        expect(stored.user_id).toBe(otherUser.userId);
        expect(fs.existsSync(path.join(resolveSpaceUploadRoot(spaceId), stored.path))).toBe(true);

        db.prepare(`
            INSERT INTO notes (id, user_id, folder_id, title, content, created_at, updated_at)
            VALUES (?, ?, NULL, ?, ?, ?, ?)
        `).run(
            uuidv4(),
            user.userId,
            'Shared image Document',
            `![shared](/images/${uploadResponse.body.id}?space=${spaceId})`,
            new Date().toISOString(),
            new Date().toISOString(),
        );

        const listResponse = await request(app)
            .get(`/images?space=${spaceId}`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .expect(200);
        expect(listResponse.headers['cache-control']).toBe('private, no-store');
        expect(listResponse.body.images).toEqual([
            expect.objectContaining({
                id: uploadResponse.body.id,
                url: `/images/${uploadResponse.body.id}?space=${spaceId}`,
                usageCount: 1,
            }),
        ]);

        const statsResponse = await request(app)
            .get(`/images/stats?space=${spaceId}`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .expect(200);
        expect(statsResponse.body).toMatchObject({
            imageCount: 1,
            totalImageBytes: TEST_PNG_BUFFER.length,
            quotaBytes: 1024 * 1024 * 1024,
        });

        const usageResponse = await request(app)
            .get(`/images/${uploadResponse.body.id}/usage?space=${spaceId}`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .expect(200);
        expect(usageResponse.body.usage.count).toBe(1);

        const readResponse = await request(app)
            .get(`/images/${uploadResponse.body.id}?space=${spaceId}&token=${encodeURIComponent(editorToken)}`)
            .expect(200);
        expect(readResponse.headers['cache-control']).toBe('private, no-store');
        expect(readResponse.body).toEqual(TEST_PNG_BUFFER);

        await request(app)
            .delete(`/images/${uploadResponse.body.id}?space=${spaceId}`)
            .set('Authorization', `Bearer ${editorToken}`)
            .send({ force: true })
            .expect(200);
        expect(db.prepare('SELECT id FROM images WHERE id = ?').get(uploadResponse.body.id)).toBeUndefined();
    });

    it('returns the same non-disclosing 404 on every qualified image route for a non-member', async () => {
        const space = createTestSpace();
        const spaceId = space.spaceId;
        const ownerToken = getTestToken(user.userId);
        const outsiderToken = getTestToken(uuidv4());
        const uploaded = await request(app)
            .post(`/images?space=${spaceId}`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .attach('image', path.join(FIXTURES_DIR, 'test-image.png'))
            .expect(201);

        const requests = [
            request(app).get(`/images?space=${spaceId}`).set('Authorization', `Bearer ${outsiderToken}`),
            request(app).get(`/images/stats?space=${spaceId}`).set('Authorization', `Bearer ${outsiderToken}`),
            request(app).get(`/images/${uploaded.body.id}/usage?space=${spaceId}`).set('Authorization', `Bearer ${outsiderToken}`),
            request(app).get(`/images/${uploaded.body.id}?space=${spaceId}&token=${encodeURIComponent(outsiderToken)}`),
            request(app).post(`/images?space=${spaceId}`).set('Authorization', `Bearer ${outsiderToken}`).attach('image', path.join(FIXTURES_DIR, 'test-image.png')),
            request(app).delete(`/images/${uploaded.body.id}?space=${spaceId}`).set('Authorization', `Bearer ${outsiderToken}`).send({ force: true }),
            request(app).post(`/images/bulk-delete?space=${spaceId}`).set('Authorization', `Bearer ${outsiderToken}`).send({ ids: [uploaded.body.id], force: true }),
        ];

        for (const pendingRequest of requests) {
            const response = await pendingRequest;
            expect(response.status).toBe(404);
            expect(response.body).toEqual({ error: 'Not found', code: 'SPACE_NOT_FOUND' });
            expect(response.headers['cache-control']).toBe('private, no-store');
        }
    });

    it('bulk-deletes and prunes only inside the qualified space upload root', async () => {
        const space = createTestSpace();
        const spaceId = space.spaceId;
        const token = getTestToken(user.userId);
        const first = await request(app)
            .post(`/images?space=${spaceId}`)
            .set('Authorization', `Bearer ${token}`)
            .attach('image', path.join(FIXTURES_DIR, 'test-image.png'))
            .expect(201);
        const second = await request(app)
            .post(`/images?space=${spaceId}`)
            .set('Authorization', `Bearer ${token}`)
            .attach('image', path.join(FIXTURES_DIR, 'test-image.png'))
            .expect(201);

        await request(app)
            .post(`/images/bulk-delete?space=${spaceId}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ ids: [first.body.id], force: false })
            .expect(200, { results: [{ id: first.body.id, deleted: true }] });

        const db = getDb(`space:${spaceId}`);
        db.prepare('UPDATE images SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', second.body.id);
        expect(pruneOrphanImagesForDb(`space:${spaceId}`, { maxDeletes: 1, olderThanDays: 7 })).toBe(1);
        expect(db.prepare('SELECT id FROM images WHERE id = ?').get(second.body.id)).toBeUndefined();
    });

    it('enforces the shared-space image quota before recording an upload', async () => {
        const space = createTestSpace();
        const spaceId = space.spaceId;
        const db = getDb(`space:${spaceId}`);
        db.prepare(`
            INSERT INTO images (id, user_id, filename, mime_type, path, size_bytes, sha256, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            uuidv4(),
            user.userId,
            'quota-reservation.png',
            'image/png',
            'quota-reservation.png',
            1024 * 1024 * 1024,
            '',
            new Date().toISOString(),
        );

        const response = await request(app)
            .post(`/images?space=${spaceId}`)
            .set('Authorization', `Bearer ${getTestToken(user.userId)}`)
            .attach('image', path.join(FIXTURES_DIR, 'test-image.png'));

        expect(response.status).toBe(413);
        expect(response.body).toEqual({
            error: 'Image storage quota exceeded',
            code: 'IMAGE_QUOTA_EXCEEDED',
        });
        expect(db.prepare('SELECT COUNT(*) AS count FROM images').get().count).toBe(1);
    });

    it('starts prune scheduler when enabled and runs on interval tick', () => {
        const oldNodeEnv = process.env.NODE_ENV;
        const oldDisableFlag = process.env.IMAGE_PRUNE_DISABLED;

        process.env.NODE_ENV = 'development';
        delete process.env.IMAGE_PRUNE_DISABLED;

        const oldDate = '2026-01-01T00:00:00.000Z';
        insertImageRecord(user.userId, {
            id: 'img-interval-old-unused',
            filename: 'interval-old-unused.png',
            mimeType: 'image/png',
            path: 'interval-old-unused.png',
            sizeBytes: 10,
            createdAt: oldDate,
        });

        vi.useFakeTimers();
        let timerId = null;
        try {
            timerId = startImageOrphanPruneJob();
            expect(timerId).toBeTruthy();

            vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 10);

            const db = getUserDb(user.userId);
            expect(db.prepare('SELECT id FROM images WHERE id = ?').get('img-interval-old-unused')).toBeUndefined();
        } finally {
            if (timerId) {
                clearInterval(timerId);
            }
            vi.useRealTimers();
            process.env.NODE_ENV = oldNodeEnv;
            if (oldDisableFlag === undefined) {
                delete process.env.IMAGE_PRUNE_DISABLED;
            } else {
                process.env.IMAGE_PRUNE_DISABLED = oldDisableFlag;
            }
        }
    });
});
