import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { v4 as uuidv4 } from "uuid";
import { addEditorMember, createSpace, removeEditorMember } from "../../spaces.js";
import { deleteTestDb, getDb, getSpacesDb } from "../../db.js";
import { revokeSpaceSubscribers } from "../../websocket.js";
import { cleanupTestUser, createTestApp, generateSiteId, getTestToken, setupTestUser } from "../testHelpers.js";

const PORT = 8015;
const originalShared = process.env.SHARED_SPACES_ENABLED;
const originalLive = process.env.LIVE_SESSIONS_ENABLED;

function waitFor(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => cleanup(reject, new Error("Timed out waiting for WebSocket message")), timeoutMs);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (predicate(message)) cleanup(resolve, message);
    };
    const cleanup = (done, value) => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      done(value);
    };
    ws.on("message", onMessage);
  });
}

async function openSocket(userId, siteId) {
  const ws = new WebSocket(`ws://localhost:${PORT}?token=${getTestToken(userId)}&siteId=${siteId}`);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return ws;
}

async function request(ws, type, payload) {
  const requestId = uuidv4();
  const response = waitFor(ws, (message) => message.requestId === requestId);
  ws.send(JSON.stringify({ v: 1, type, requestId, payload }));
  return response;
}

async function close(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => { ws.once("close", resolve); ws.close(); });
}

function updateBase64(doc, mutate) {
  let update;
  const listener = (bytes, origin) => { if (origin === "local") update = bytes; };
  doc.on("update", listener);
  doc.transact(mutate, "local");
  doc.off("update", listener);
  return Buffer.from(update).toString("base64");
}

describe("COLLAB-05 live session protocol", () => {
  let server;
  let manager;
  let clients;
  let owner;
  let editor;
  let outsider;
  let spaceId;
  let noteId;
  let sockets = [];

  beforeAll(async () => {
    process.env.SHARED_SPACES_ENABLED = "true";
    process.env.LIVE_SESSIONS_ENABLED = "true";
    const app = createTestApp();
    server = app.server;
    manager = app.collabManager;
    clients = app.clients;
    await new Promise((resolve) => server.listen(PORT, resolve));
  });

  beforeEach(async () => {
    process.env.SHARED_SPACES_ENABLED = "true";
    process.env.LIVE_SESSIONS_ENABLED = "true";
    const stamp = `${Date.now()}-${Math.random()}`;
    owner = await setupTestUser(`collab-owner-${stamp}@example.test`, "password123");
    editor = await setupTestUser(`collab-editor-${stamp}@example.test`, "password123");
    outsider = await setupTestUser(`collab-outsider-${stamp}@example.test`, "password123");
    spaceId = createSpace({ actorUserId: owner.userId, name: "Live Writers" }).spaceId;
    addEditorMember({ actorUserId: owner.userId, spaceId, userId: editor.userId });
    noteId = uuidv4();
    getDb(`space:${spaceId}`).prepare(`
      INSERT INTO notes (id, user_id, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(noteId, owner.userId, "Draft", "base", new Date().toISOString(), new Date().toISOString());
  });

  afterEach(async () => {
    await Promise.all(sockets.map(close));
    sockets = [];
    await manager.shutdown({ deadlineMs: 2000 });
    for (const session of [...manager.sessions.values()]) {
      manager.closeSession(session, "shutdown", { deleteRecovery: true });
    }
    manager.accepting = true;
    if (spaceId) {
      getSpacesDb().prepare("DELETE FROM space_members WHERE space_id = ?").run(spaceId);
      getSpacesDb().prepare("DELETE FROM spaces WHERE id = ?").run(spaceId);
      deleteTestDb(`space:${spaceId}`);
    }
    for (const user of [owner, editor, outsider]) if (user) cleanupTestUser(user.userId);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (originalShared === undefined) delete process.env.SHARED_SPACES_ENABLED;
    else process.env.SHARED_SPACES_ENABLED = originalShared;
    if (originalLive === undefined) delete process.env.LIVE_SESSIONS_ENABLED;
    else process.env.LIVE_SESSIONS_ENABLED = originalLive;
  });

  async function subscribedSocket(user, char) {
    const siteId = generateSiteId(char);
    const ws = await openSocket(user.userId, siteId);
    sockets.push(ws);
    const subscribed = await request(ws, "subscribe", { databases: [{ dbKey: `space:${spaceId}`, siteId }] });
    expect(subscribed.ok).toBe(true);
    return ws;
  }

  it("converges after durable acknowledgement and saves one attributable revision", async () => {
    const a = await subscribedSocket(owner, "a");
    const b = await subscribedSocket(editor, "b");
    const stateA = await request(a, "collab:open", { space: spaceId, noteId });
    const stateB = await request(b, "collab:open", { space: spaceId, noteId });
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    Y.applyUpdate(docA, Buffer.from(stateA.payload.update, "base64"));
    Y.applyUpdate(docB, Buffer.from(stateB.payload.update, "base64"));

    const update = updateBase64(docA, () => docA.getText("content").insert(4, " together"));
    const broadcast = waitFor(b, (message) => message.type === "collab:update");
    const ack = await request(a, "collab:update", { sessionId: stateA.payload.sessionId, seq: 1, update });
    expect(ack.type).toBe("collab:ack");
    const durable = getDb(`space:${spaceId}`).prepare("SELECT durable_sequence, ydoc_state FROM collab_sessions WHERE note_id = ?").get(noteId);
    expect(durable.durable_sequence).toBe(1);
    const forwarded = await broadcast;
    Y.applyUpdate(docB, Buffer.from(forwarded.payload.update, "base64"));
    expect(docB.getText("content").toString()).toBe("base together");

    const committed = await request(a, "collab:commit", { sessionId: stateA.payload.sessionId });
    expect(committed.payload.result).toBe("applied");
    expect(getDb(`space:${spaceId}`).prepare("SELECT content FROM notes WHERE id = ?").get(noteId).content).toBe("base together");
    const revisions = getDb(`space:${spaceId}`).prepare(
      "SELECT actor_user_id, actor_kind FROM note_revisions WHERE note_id = ?",
    ).all(noteId);
    expect(revisions).toEqual([{ actor_user_id: owner.userId, actor_kind: "collab" }]);
  });

  it("uses the same non-disclosing response for an outsider and an unknown document", async () => {
    const outsiderWs = await openSocket(outsider.userId, generateSiteId("c"));
    sockets.push(outsiderWs);
    const denied = await request(outsiderWs, "collab:open", { space: spaceId, noteId });
    const memberWs = await subscribedSocket(owner, "d");
    const missing = await request(memberWs, "collab:open", { space: spaceId, noteId: uuidv4() });
    expect([denied.error.code, denied.error.message]).toEqual(["SPACE_NOT_FOUND", "Document not found"]);
    expect([missing.error.code, missing.error.message]).toEqual(["SPACE_NOT_FOUND", "Document not found"]);
  });

  it("restores durable state, acknowledges a duplicate once, and rejects malformed updates without mutation", async () => {
    const ws = await subscribedSocket(owner, "f");
    const opened = await request(ws, "collab:open", { space: spaceId, noteId });
    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, Buffer.from(opened.payload.update, "base64"));
    const update = updateBase64(clientDoc, () => clientDoc.getText("content").insert(4, " durable"));
    await request(ws, "collab:update", { sessionId: opened.payload.sessionId, seq: 1, update });
    const session = manager.sessionsById.get(opened.payload.sessionId);
    manager.closeSession(session, "shutdown");

    const restored = await request(ws, "collab:open", { space: spaceId, noteId });
    const restoredDoc = new Y.Doc();
    Y.applyUpdate(restoredDoc, Buffer.from(restored.payload.update, "base64"));
    expect(restoredDoc.getText("content").toString()).toBe("base durable");
    const duplicate = await request(ws, "collab:update", { sessionId: restored.payload.sessionId, seq: 1, update });
    expect(duplicate.type).toBe("collab:ack");
    expect(getDb(`space:${spaceId}`).prepare(
      "SELECT durable_sequence FROM collab_sessions WHERE note_id = ?",
    ).get(noteId).durable_sequence).toBe(1);
    const malformed = await request(ws, "collab:update", {
      sessionId: restored.payload.sessionId, seq: 2, update: "not-base64",
    });
    expect(malformed.error.code).toBe("INVALID_UPDATE");
    expect(manager.sessionsById.get(restored.payload.sessionId).ydoc.getText("content").toString()).toBe("base durable");
  });

  it("three-way merges a non-overlapping outside edit and preserves a conflicting outside body", async () => {
    const db = getDb(`space:${spaceId}`);
    db.prepare("UPDATE notes SET content = ? WHERE id = ?").run("one\ntwo\nthree", noteId);
    const ws = await subscribedSocket(owner, "1");
    const opened = await request(ws, "collab:open", { space: spaceId, noteId });
    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, Buffer.from(opened.payload.update, "base64"));
    const update = updateBase64(clientDoc, () => {
      const text = clientDoc.getText("content");
      text.delete(0, 3);
      text.insert(0, "ONE");
    });
    await request(ws, "collab:update", { sessionId: opened.payload.sessionId, seq: 1, update });
    db.prepare("UPDATE notes SET content = ? WHERE id = ?").run("one\ntwo\nTHREE", noteId);
    const merged = await request(ws, "collab:commit", { sessionId: opened.payload.sessionId });
    expect(merged.payload.result).toBe("merged");
    expect(db.prepare("SELECT content FROM notes WHERE id = ?").get(noteId).content).toBe("ONE\ntwo\nTHREE");

    // Start a fresh base, then change the same line both inside and outside.
    manager.closeSession(manager.sessionsById.get(opened.payload.sessionId), "committed", { deleteRecovery: true });
    db.prepare("UPDATE notes SET content = ? WHERE id = ?").run("base", noteId);
    const reopened = await request(ws, "collab:open", { space: spaceId, noteId });
    const conflictDoc = new Y.Doc();
    Y.applyUpdate(conflictDoc, Buffer.from(reopened.payload.update, "base64"));
    const conflictingUpdate = updateBase64(conflictDoc, () => {
      conflictDoc.getText("content").delete(0, 4);
      conflictDoc.getText("content").insert(0, "inside");
    });
    await request(ws, "collab:update", { sessionId: reopened.payload.sessionId, seq: 1, update: conflictingUpdate });
    db.prepare("UPDATE notes SET content = ? WHERE id = ?").run("outside", noteId);
    const conflict = await request(ws, "collab:commit", { sessionId: reopened.payload.sessionId });
    expect(conflict.payload.result).toBe("conflict");
    expect(conflict.payload.conflicts.length).toBeGreaterThan(0);
    expect(db.prepare("SELECT content FROM notes WHERE id = ?").get(noteId).content).toBe("outside");
    expect(db.prepare("SELECT 1 FROM collab_sessions WHERE note_id = ?").get(noteId)).toBeDefined();

    // Once every participant has left, an unresolved checkpoint stays durable
    // without occupying one of the bounded in-memory session slots forever.
    const conflictedSession = manager.sessionsById.get(reopened.payload.sessionId);
    const serverSocket = [...conflictedSession.participants.keys()][0];
    manager.leave(serverSocket, clients.get(serverSocket), reopened.payload.sessionId, "left");
    expect(conflictedSession.participants.size).toBe(0);
    await manager.autoCommitAndClose(conflictedSession, "committed");
    expect(manager.sessionsById.has(reopened.payload.sessionId)).toBe(false);
    expect(db.prepare("SELECT 1 FROM collab_sessions WHERE note_id = ?").get(noteId)).toBeDefined();
  });

  it("rejects new admission when the live-session flag is disabled", async () => {
    const ws = await subscribedSocket(owner, "e");
    process.env.LIVE_SESSIONS_ENABLED = "false";
    const response = await request(ws, "collab:open", { space: spaceId, noteId });
    expect(response.error.code).toBe("FEATURE_DISABLED");
  });

  it("removes a revoked participant immediately and retains other editors", async () => {
    const ownerWs = await subscribedSocket(owner, "2");
    const editorWs = await subscribedSocket(editor, "3");
    const ownerState = await request(ownerWs, "collab:open", { space: spaceId, noteId });
    await request(editorWs, "collab:open", { space: spaceId, noteId });
    const closed = waitFor(editorWs, (message) => message.type === "collab:closed");
    removeEditorMember({ actorUserId: owner.userId, spaceId, userId: editor.userId });
    revokeSpaceSubscribers(clients, `space:${spaceId}`, [editor.userId]);
    expect((await closed).payload.reason).toBe("revoked");
    expect(manager.sessionsById.get(ownerState.payload.sessionId).participants.size).toBe(1);
  });

  it("auto-saves a wholly durable session during graceful shutdown", async () => {
    const ws = await subscribedSocket(owner, "4");
    const opened = await request(ws, "collab:open", { space: spaceId, noteId });
    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, Buffer.from(opened.payload.update, "base64"));
    const update = updateBase64(clientDoc, () => clientDoc.getText("content").insert(4, " before shutdown"));
    await request(ws, "collab:update", { sessionId: opened.payload.sessionId, seq: 1, update });
    const result = await manager.shutdown({ deadlineMs: 2000 });
    expect(result).toEqual({ flushed: 1, unflushed: 0 });
    const db = getDb(`space:${spaceId}`);
    expect(db.prepare("SELECT content FROM notes WHERE id = ?").get(noteId).content).toBe("base before shutdown");
    expect(db.prepare("SELECT 1 FROM collab_sessions WHERE note_id = ?").get(noteId)).toBeUndefined();
  });
});
