// Integration tests for the COLLAB-00 v1 WebSocket subscribe/unsubscribe
// protocol (COLLAB-04 Phase 2): atomic subscription validation/idempotence,
// non-disclosing rejection of unauthorized targets, space-scoped pokes with
// site-id exclusion, membership re-check at poke time, and invalid/duplicate
// site id handling. Legacy handshake and personal `{type:'sync'}` poke
// behavior are covered by websocket.test.js and are not repeated here.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { createTestApp, setupTestUser, cleanupTestUser, getTestToken } from '../testHelpers.js';
import { deleteTestDb, getSpacesDb } from '../../db.js';
import { createSpace, addEditorMember, removeEditorMember } from '../../spaces.js';

const WS_PORT = 8010;
// This file opens many more sockets per run than the legacy websocket.test.js
// (roughly one connection per test, several with 2-3), so under a full-suite
// concurrent run it needs more slack for the initial connect than a fixed
// 2000ms budget provides; bump to reduce environment-load flakiness without
// weakening any assertion.
const WEBSOCKET_TIMEOUT = 8000;
const FLAG = 'SHARED_SPACES_ENABLED';
const ORIGINAL_FLAG_VALUE = process.env[FLAG];

// The v1 subscribe/unsubscribe protocol requires 32 lowercase-hex-character
// site ids (COLLAB-00 §4); unlike the legacy handshake's free-form siteId
// query param, a non-hex string here is a real INVALID_SITE_ID case, so
// tests need guaranteed-valid, guaranteed-distinct ids.
let hexSiteIdSeed = 0;
function hexSiteId() {
    hexSiteIdSeed += 1;
    return hexSiteIdSeed.toString(16).padStart(32, '0');
}

function waitForEvent(ws, eventName) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for WebSocket ${eventName} event`));
        }, WEBSOCKET_TIMEOUT);

        const onEvent = (...args) => {
            cleanup();
            resolve(args);
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const cleanup = () => {
            clearTimeout(timeout);
            ws.off(eventName, onEvent);
            ws.off('error', onError);
        };

        ws.once(eventName, onEvent);
        ws.once('error', onError);
    });
}

async function openWebSocket(url) {
    const ws = new WebSocket(url);
    await waitForEvent(ws, 'open');
    return ws;
}

async function closeWebSocket(ws) {
    if (ws.readyState === WebSocket.CLOSED) return;
    const closed = waitForEvent(ws, 'close');
    ws.close();
    await closed;
}

function getServerSocket(clients, siteId) {
    const entry = [...clients.entries()].find(([, clientInfo]) => clientInfo.siteId === siteId);
    expect(entry).toBeDefined();
    return entry[0];
}

/** Waits for the next message on `ws` matching `predicate`, ignoring others. */
function waitForMessage(ws, predicate = () => true, timeout = WEBSOCKET_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            cleanup();
            reject(new Error('Timed out waiting for a matching WebSocket message'));
        }, timeout);

        const onMessage = (data) => {
            let parsed;
            try {
                parsed = JSON.parse(data.toString());
            } catch {
                parsed = null;
            }
            if (parsed && predicate(parsed)) {
                cleanup();
                resolve(parsed);
            }
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const cleanup = () => {
            clearTimeout(t);
            ws.off('message', onMessage);
            ws.off('error', onError);
        };

        ws.on('message', onMessage);
        ws.once('error', onError);
    });
}

// COLLAB-00 §4: the subscribe request payload is `{ databases: [...] }`
// (the success *response* payload uses a different key, `subscriptions`,
// for the resulting subscription list — the two must not be confused).
function subscribe(ws, databases, requestId = uuidv4()) {
    const message = { v: 1, type: 'subscribe', requestId, payload: { databases } };
    const response = waitForMessage(ws, (m) => m.requestId === requestId);
    ws.send(JSON.stringify(message));
    return response;
}

function unsubscribe(ws, dbKeys, requestId = uuidv4()) {
    const message = { v: 1, type: 'unsubscribe', requestId, payload: { dbKeys } };
    const response = waitForMessage(ws, (m) => m.requestId === requestId);
    ws.send(JSON.stringify(message));
    return response;
}

describe('WebSocket v1 subscribe/unsubscribe protocol (shared spaces)', () => {
    let app, server, clients;
    let owner, editor, outsider;
    let ownerToken, editorToken, outsiderToken;
    let spaceId;

    beforeAll(() => {
        const result = createTestApp();
        app = result.app;
        server = result.server;
        clients = result.clients;
        return new Promise((resolve) => {
            server.listen(WS_PORT, resolve);
        });
    });

    afterAll(() => {
        if (ORIGINAL_FLAG_VALUE === undefined) delete process.env[FLAG];
        else process.env[FLAG] = ORIGINAL_FLAG_VALUE;
        return new Promise((resolve) => {
            if (server) server.close(resolve);
            else resolve();
        });
    });

    beforeEach(async () => {
        process.env[FLAG] = 'true';
        const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        owner = await setupTestUser(`ws-space-owner-${stamp}@example.com`, 'password123');
        editor = await setupTestUser(`ws-space-editor-${stamp}@example.com`, 'password123');
        outsider = await setupTestUser(`ws-space-outsider-${stamp}@example.com`, 'password123');
        ownerToken = getTestToken(owner.userId);
        editorToken = getTestToken(editor.userId);
        outsiderToken = getTestToken(outsider.userId);

        const created = createSpace({ actorUserId: owner.userId, name: `WS Test Space ${stamp}` });
        spaceId = created.spaceId;
        addEditorMember({ actorUserId: owner.userId, spaceId, userId: editor.userId });
    });

    afterEach(() => {
        if (spaceId) {
            try {
                const spacesDb = getSpacesDb();
                spacesDb.prepare('DELETE FROM space_members WHERE space_id = ?').run(spaceId);
                spacesDb.prepare('DELETE FROM space_invites WHERE space_id = ?').run(spaceId);
                spacesDb.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId);
            } catch (error) {
                console.error('Error cleaning up test space metadata:', error);
            }
            deleteTestDb(`space:${spaceId}`);
        }
        for (const user of [owner, editor, outsider]) {
            if (!user) continue;
            try {
                getSpacesDb().prepare('DELETE FROM space_user_versions WHERE user_id = ?').run(user.userId);
            } catch (error) {
                console.error('Error cleaning up space_user_versions:', error);
            }
        }
        if (owner) cleanupTestUser(owner.userId);
        if (editor) cleanupTestUser(editor.userId);
        if (outsider) cleanupTestUser(outsider.userId);
        process.env[FLAG] = 'true';
    });

    it('starts every new socket with empty subscriptions', async () => {
        const siteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const serverWs = getServerSocket(clients, siteId);
            expect(clients.get(serverWs).subscriptions.size).toBe(0);
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('subscribes to the caller\'s own personal dbKey and returns membershipVersion', async () => {
        const siteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const response = await subscribe(ws, [{ dbKey: `user:${owner.userId}`, siteId }]);
            expect(response.ok).toBe(true);
            expect(response.v).toBe(1);
            expect(response.type).toBe('subscribe');
            expect(response.payload.subscriptions).toEqual([{ dbKey: `user:${owner.userId}`, siteId }]);
            expect(typeof response.payload.membershipVersion).toBe('number');
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('subscribes an owner and an editor to the shared space dbKey', async () => {
        const ownerSiteId = hexSiteId();
        const editorSiteId = hexSiteId();
        const ownerWs = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${ownerSiteId}`);
        const editorWs = await openWebSocket(`ws://localhost:${WS_PORT}?token=${editorToken}&siteId=${editorSiteId}`);
        try {
            const ownerResponse = await subscribe(ownerWs, [{ dbKey: `space:${spaceId}`, siteId: ownerSiteId }]);
            expect(ownerResponse.ok).toBe(true);
            expect(ownerResponse.payload.subscriptions).toEqual([{ dbKey: `space:${spaceId}`, siteId: ownerSiteId }]);

            const editorResponse = await subscribe(editorWs, [{ dbKey: `space:${spaceId}`, siteId: editorSiteId }]);
            expect(editorResponse.ok).toBe(true);
        } finally {
            await Promise.all([closeWebSocket(ownerWs), closeWebSocket(editorWs)]);
        }
    });

    it('rejects a nonmember subscribing to the space with a non-disclosing SPACE_NOT_FOUND', async () => {
        const siteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${outsiderToken}&siteId=${siteId}`);
        try {
            const response = await subscribe(ws, [{ dbKey: `space:${spaceId}`, siteId }]);
            expect(response.ok).toBe(false);
            expect(response.error.code).toBe('SPACE_NOT_FOUND');
            expect(clients.get(getServerSocket(clients, siteId)).subscriptions.size).toBe(0);
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('rejects a subscription to an unknown space id with the identical SPACE_NOT_FOUND code', async () => {
        const siteId = hexSiteId();
        const unknownSpaceId = '00000000-0000-4000-8000-000000000000';
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const response = await subscribe(ws, [{ dbKey: `space:${unknownSpaceId}`, siteId }]);
            expect(response.ok).toBe(false);
            expect(response.error.code).toBe('SPACE_NOT_FOUND');
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('rejects subscribing to another user\'s personal dbKey (non-disclosing)', async () => {
        const siteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const response = await subscribe(ws, [{ dbKey: `user:${editor.userId}`, siteId }]);
            expect(response.ok).toBe(false);
            expect(response.error.code).toBe('SPACE_NOT_FOUND');
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('atomically rejects an entire batch when one entry is invalid, committing nothing', async () => {
        const siteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const response = await subscribe(ws, [
                { dbKey: `user:${owner.userId}`, siteId },
                { dbKey: `space:${spaceId}`, siteId: 'not-a-valid-site-id' },
            ]);
            expect(response.ok).toBe(false);
            expect(response.error.code).toBe('INVALID_SITE_ID');

            const serverWs = getServerSocket(clients, siteId);
            expect(clients.get(serverWs).subscriptions.size).toBe(0);
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('atomically rejects a batch containing an unauthorized target, committing nothing', async () => {
        const siteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const response = await subscribe(ws, [
                { dbKey: `user:${owner.userId}`, siteId },
                { dbKey: `space:${'00000000-0000-4000-8000-000000000000'}`, siteId },
            ]);
            expect(response.ok).toBe(false);
            expect(response.error.code).toBe('SPACE_NOT_FOUND');

            const serverWs = getServerSocket(clients, siteId);
            expect(clients.get(serverWs).subscriptions.size).toBe(0);
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('is idempotent when re-subscribing to the same dbKey and site id', async () => {
        const siteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const first = await subscribe(ws, [{ dbKey: `space:${spaceId}`, siteId }]);
            expect(first.ok).toBe(true);

            const second = await subscribe(ws, [{ dbKey: `space:${spaceId}`, siteId }]);
            expect(second.ok).toBe(true);
            expect(second.payload.subscriptions).toEqual([{ dbKey: `space:${spaceId}`, siteId }]);

            const serverWs = getServerSocket(clients, siteId);
            expect(clients.get(serverWs).subscriptions.size).toBe(1);
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('rejects re-subscribing to the same dbKey with a conflicting site id and keeps the original', async () => {
        const siteId = hexSiteId();
        const otherSiteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const first = await subscribe(ws, [{ dbKey: `space:${spaceId}`, siteId }]);
            expect(first.ok).toBe(true);

            const second = await subscribe(ws, [{ dbKey: `space:${spaceId}`, siteId: otherSiteId }]);
            expect(second.ok).toBe(false);
            expect(second.error.code).toBe('SUBSCRIPTION_CONFLICT');

            const serverWs = getServerSocket(clients, siteId);
            expect(clients.get(serverWs).subscriptions.get(`space:${spaceId}`)).toBe(siteId);
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('rejects two conflicting site ids for the same dbKey within a single request', async () => {
        const siteId = hexSiteId();
        const otherSiteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const response = await subscribe(ws, [
                { dbKey: `space:${spaceId}`, siteId },
                { dbKey: `space:${spaceId}`, siteId: otherSiteId },
            ]);
            expect(response.ok).toBe(false);
            expect(response.error.code).toBe('SUBSCRIPTION_CONFLICT');

            const serverWs = getServerSocket(clients, siteId);
            expect(clients.get(serverWs).subscriptions.size).toBe(0);
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('rejects a malformed (non-32-lowercase-hex) site id', async () => {
        const siteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const response = await subscribe(ws, [{ dbKey: `space:${spaceId}`, siteId: 'ABCDEF' }]);
            expect(response.ok).toBe(false);
            expect(response.error.code).toBe('INVALID_SITE_ID');
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('unsubscribes and is idempotent for an already-unknown dbKey', async () => {
        const siteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            await subscribe(ws, [{ dbKey: `space:${spaceId}`, siteId }]);

            const first = await unsubscribe(ws, [`space:${spaceId}`]);
            expect(first.ok).toBe(true);
            expect(first.payload.subscriptions).toEqual([]);

            // Unsubscribing again (already gone) is a no-op success, not an error.
            const second = await unsubscribe(ws, [`space:${spaceId}`, 'user:00000000-0000-4000-8000-000000000000']);
            expect(second.ok).toBe(true);
            expect(second.payload.subscriptions).toEqual([]);

            const serverWs = getServerSocket(clients, siteId);
            expect(clients.get(serverWs).subscriptions.size).toBe(0);
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('responds with a versioned error and does not mutate state for an unsupported protocol version', async () => {
        const siteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const requestId = uuidv4();
            const response = waitForMessage(ws, (m) => m.requestId === requestId || m.error);
            ws.send(JSON.stringify({ v: 2, type: 'subscribe', requestId, payload: { databases: [{ dbKey: `space:${spaceId}`, siteId }] } }));
            const result = await response;
            expect(result.ok).toBe(false);
            expect(result.error.code).toBe('UNSUPPORTED_PROTOCOL');

            const serverWs = getServerSocket(clients, siteId);
            expect(clients.get(serverWs).subscriptions.size).toBe(0);
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('responds with INVALID_REQUEST and does not mutate state when requestId is missing/malformed', async () => {
        const siteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const response = waitForMessage(ws, (m) => m.error);
            ws.send(JSON.stringify({ v: 1, type: 'subscribe', requestId: 'not-a-uuid', payload: { databases: [{ dbKey: `space:${spaceId}`, siteId }] } }));
            const result = await response;
            expect(result.ok).toBe(false);
            expect(result.error.code).toBe('INVALID_REQUEST');

            const serverWs = getServerSocket(clients, siteId);
            expect(clients.get(serverWs).subscriptions.size).toBe(0);
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('responds with UNKNOWN_MESSAGE for an unsupported message type', async () => {
        const siteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const requestId = uuidv4();
            const response = waitForMessage(ws, (m) => m.requestId === requestId);
            ws.send(JSON.stringify({ v: 1, type: 'not-a-real-type', requestId, payload: {} }));
            const result = await response;
            expect(result.ok).toBe(false);
            expect(result.error.code).toBe('UNKNOWN_MESSAGE');
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('responds with UNKNOWN_MESSAGE for malformed JSON without crashing the connection', async () => {
        const siteId = hexSiteId();
        const ws = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${siteId}`);
        try {
            const response = waitForMessage(ws, (m) => m.error);
            ws.send('{ this is not valid json');
            const result = await response;
            expect(result.ok).toBe(false);
            expect(result.error.code).toBe('UNKNOWN_MESSAGE');

            // Connection must remain usable afterwards.
            const follow = await subscribe(ws, [{ dbKey: `user:${owner.userId}`, siteId }]);
            expect(follow.ok).toBe(true);
        } finally {
            await closeWebSocket(ws);
        }
    });

    it('pokes only currently-subscribed sockets for a space dbKey, excluding the same site id', async () => {
        const ownerSiteId = hexSiteId();
        const editorSiteId = hexSiteId();
        const bystanderSiteId = hexSiteId();
        const ownerWs = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${ownerSiteId}`);
        const editorWs = await openWebSocket(`ws://localhost:${WS_PORT}?token=${editorToken}&siteId=${editorSiteId}`);
        // A second owner connection that never subscribes to the space; it
        // must not receive the space poke.
        const bystanderWs = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${bystanderSiteId}`);

        try {
            await subscribe(ownerWs, [{ dbKey: `space:${spaceId}`, siteId: ownerSiteId }]);
            await subscribe(editorWs, [{ dbKey: `space:${spaceId}`, siteId: editorSiteId }]);

            const editorNotification = waitForMessage(editorWs, (m) => m.type === 'sync');
            const bystanderNotification = waitForMessage(bystanderWs, () => true, 400).catch(() => 'timeout');

            await request(app)
                .post('/sync')
                .set('Authorization', `Bearer ${ownerToken}`)
                .send({
                    space: spaceId,
                    since: 0,
                    siteId: ownerSiteId,
                    changes: [
                        {
                            table: 'folders',
                            pk: '["folder-poke-test"]',
                            cid: 'name',
                            val: '"Poke test"',
                            col_version: 1,
                            db_version: 1,
                            site_id: ownerSiteId,
                            cl: 0,
                            seq: 1,
                        },
                    ],
                })
                .expect(200);

            const editorResult = await editorNotification;
            expect(editorResult).toEqual({ v: 1, type: 'sync', payload: { dbKey: `space:${spaceId}` } });

            const bystanderResult = await bystanderNotification;
            expect(bystanderResult).toBe('timeout');
        } finally {
            await Promise.all([closeWebSocket(ownerWs), closeWebSocket(editorWs), closeWebSocket(bystanderWs)]);
        }
    });

    it('does not poke the originating site id for its own space sync', async () => {
        const ownerSiteId = hexSiteId();
        const ownerWs = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${ownerSiteId}`);

        try {
            await subscribe(ownerWs, [{ dbKey: `space:${spaceId}`, siteId: ownerSiteId }]);

            const noSelfPoke = waitForMessage(ownerWs, (m) => m.type === 'sync', 400).catch(() => 'timeout');

            await request(app)
                .post('/sync')
                .set('Authorization', `Bearer ${ownerToken}`)
                .send({
                    space: spaceId,
                    since: 0,
                    siteId: ownerSiteId,
                    changes: [
                        {
                            table: 'folders',
                            pk: '["folder-self-exclude"]',
                            cid: 'name',
                            val: '"Self exclude"',
                            col_version: 1,
                            db_version: 1,
                            site_id: ownerSiteId,
                            cl: 0,
                            seq: 1,
                        },
                    ],
                })
                .expect(200);

            const result = await noSelfPoke;
            expect(result).toBe('timeout');
        } finally {
            await closeWebSocket(ownerWs);
        }
    });

    it('revokes a removed member immediately without waiting for a later sync poke', async () => {
        const editorSiteId = hexSiteId();
        const editorWs = await openWebSocket(`ws://localhost:${WS_PORT}?token=${editorToken}&siteId=${editorSiteId}`);

        try {
            await subscribe(editorWs, [{ dbKey: `space:${spaceId}`, siteId: editorSiteId }]);
            const revocation = waitForMessage(editorWs, (m) => m.type === 'subscription:revoked');

            await request(app)
                .delete(`/spaces/${spaceId}/members/${editor.userId}`)
                .set('Authorization', `Bearer ${ownerToken}`)
                .expect(204);

            expect(await revocation).toEqual({
                v: 1,
                type: 'subscription:revoked',
                requestId: null,
                ok: true,
                payload: { dbKey: `space:${spaceId}` },
            });
            const serverWs = getServerSocket(clients, editorSiteId);
            expect(clients.get(serverWs).subscriptions.has(`space:${spaceId}`)).toBe(false);
        } finally {
            await closeWebSocket(editorWs);
        }
    });

    it('re-checks membership at poke time, drops a revoked subscriber, and emits a revocation notice', async () => {
        const editorSiteId = hexSiteId();
        const ownerSiteId = hexSiteId();
        const editorWs = await openWebSocket(`ws://localhost:${WS_PORT}?token=${editorToken}&siteId=${editorSiteId}`);
        const ownerWs = await openWebSocket(`ws://localhost:${WS_PORT}?token=${ownerToken}&siteId=${ownerSiteId}`);

        try {
            await subscribe(editorWs, [{ dbKey: `space:${spaceId}`, siteId: editorSiteId }]);

            removeEditorMember({ actorUserId: owner.userId, spaceId, userId: editor.userId });

            const revocation = waitForMessage(editorWs, (m) => m.type === 'subscription:revoked');

            await request(app)
                .post('/sync')
                .set('Authorization', `Bearer ${ownerToken}`)
                .send({
                    space: spaceId,
                    since: 0,
                    siteId: ownerSiteId,
                    changes: [
                        {
                            table: 'folders',
                            pk: '["folder-revocation-test"]',
                            cid: 'name',
                            val: '"Revocation test"',
                            col_version: 1,
                            db_version: 1,
                            site_id: ownerSiteId,
                            cl: 0,
                            seq: 1,
                        },
                    ],
                })
                .expect(200);

            const revoked = await revocation;
            expect(revoked).toEqual({ v: 1, type: 'subscription:revoked', requestId: null, ok: true, payload: { dbKey: `space:${spaceId}` } });

            const serverWs = getServerSocket(clients, editorSiteId);
            expect(clients.get(serverWs).subscriptions.has(`space:${spaceId}`)).toBe(false);
        } finally {
            await Promise.all([closeWebSocket(editorWs), closeWebSocket(ownerWs)]);
        }
    });
});
