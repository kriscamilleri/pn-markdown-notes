import { computed, markRaw, ref, shallowRef } from "vue";
import { defineStore } from "pinia";
import * as Y from "yjs";
import { useSyncStore } from "./syncStore";
import { useDocStore } from "./docStore";
import { useUiStore } from "./uiStore";

const RECONNECT_TIMEOUT_MS = 30_000;
const SEND_BATCH_MS = 50;

function decode(value) {
  const binary = atob(value || "");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encode(value) {
  let binary = "";
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const useCollabSessionStore = defineStore("collabSessionStore", () => {
  const syncStore = useSyncStore();
  const status = ref("idle");
  const sessionId = ref(null);
  const dbKey = ref(null);
  const noteId = ref(null);
  const participants = ref([]);
  const lastError = ref(null);
  const conflictHunks = ref([]);
  const conflict = ref(null);
  const ydoc = shallowRef(null);
  const localOrigin = markRaw({ name: "panino-collab-local" });
  const pending = new Map();
  let nextSeq = 1;
  let sendTimer = null;
  let reconnectTimer = null;
  let bufferedUpdates = [];
  let removeSocketListener = null;
  let observedDoc = null;
  let lastAwarenessAt = 0;

  const isActive = computed(() => ["opening", "live", "reconnecting", "committing", "dropped"].includes(status.value));
  const isEditable = computed(() => status.value === "live" || status.value === "reconnecting");
  const unackedCount = ref(0);

  function setPendingCount() {
    unackedCount.value = pending.size + (bufferedUpdates.length ? 1 : 0);
  }

  function send(type, payload) {
    return syncStore.sendWebSocketMessage(type, payload);
  }

  function flushUpdates() {
    clearTimeout(sendTimer);
    sendTimer = null;
    if (!bufferedUpdates.length || !sessionId.value) return;
    const update = Y.mergeUpdates(bufferedUpdates);
    bufferedUpdates = [];
    const seq = nextSeq++;
    const encoded = encode(update);
    pending.set(seq, encoded);
    setPendingCount();
    send("collab:update", { sessionId: sessionId.value, seq, update: encoded });
  }

  function observeLocalUpdates(doc) {
    if (observedDoc) observedDoc.off("update", onYUpdate);
    observedDoc = doc;
    doc.on("update", onYUpdate);
  }

  function onYUpdate(update, origin) {
    if (origin !== localOrigin) return;
    bufferedUpdates.push(update);
    setPendingCount();
    if (!sendTimer) sendTimer = setTimeout(flushUpdates, SEND_BATCH_MS);
  }

  function resetDocument() {
    clearTimeout(sendTimer);
    clearTimeout(reconnectTimer);
    sendTimer = null;
    reconnectTimer = null;
    if (observedDoc) observedDoc.off("update", onYUpdate);
    observedDoc = null;
    ydoc.value?.destroy();
    ydoc.value = null;
    pending.clear();
    bufferedUpdates = [];
    unackedCount.value = 0;
    nextSeq = 1;
    lastAwarenessAt = 0;
  }

  function reset() {
    resetDocument();
    status.value = "idle";
    sessionId.value = null;
    dbKey.value = null;
    noteId.value = null;
    participants.value = [];
    lastError.value = null;
    conflictHunks.value = [];
    conflict.value = null;
  }

  function open(spaceId, documentId) {
    if (!syncStore.isOnline) {
      lastError.value = "Live sessions require an internet connection.";
      return false;
    }
    reset();
    status.value = "opening";
    dbKey.value = `space:${spaceId}`;
    noteId.value = documentId;
    const requestId = send("collab:open", { space: spaceId, noteId: documentId });
    if (!requestId) {
      status.value = "dropped";
      lastError.value = "The live connection is unavailable.";
      return false;
    }
    return true;
  }

  function installState(payload) {
    if (!payload?.sessionId || !payload?.update) return;
    if (!ydoc.value) {
      ydoc.value = markRaw(new Y.Doc());
      observeLocalUpdates(ydoc.value);
    }
    Y.applyUpdate(ydoc.value, decode(payload.update), "server-state");
    sessionId.value = payload.sessionId;
    participants.value = payload.participants || [];
    nextSeq = Math.max(nextSeq, (Number(payload.ack) || 0) + 1);
    status.value = "live";
    lastError.value = null;
    clearTimeout(reconnectTimer);
    for (const [seq, update] of pending) {
      if (seq > Number(payload.ack || 0)) send("collab:update", { sessionId: sessionId.value, seq, update });
      else pending.delete(seq);
    }
    setPendingCount();
  }

  function acknowledge(seq) {
    for (const key of [...pending.keys()]) if (key <= Number(seq)) pending.delete(key);
    setPendingCount();
  }

  async function finishSession(reason) {
    const targetDbKey = dbKey.value;
    reset();
    if (reason === "revoked") {
      useUiStore().addToast("Your access to this live session ended.", "warning");
      return;
    }
    if (targetDbKey) {
      await syncStore.sync(targetDbKey);
      await useDocStore().refreshData();
    }
  }

  function handleMessage(message) {
    if (message.type === "socket:close" && ["opening", "live", "committing"].includes(status.value)) {
      status.value = "reconnecting";
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        status.value = "dropped";
        lastError.value = "The live session could not reconnect. Your text remains available to copy.";
      }, RECONNECT_TIMEOUT_MS);
      return;
    }
    if (message.type === "socket:open" && status.value === "reconnecting" && dbKey.value && noteId.value) {
      const space = dbKey.value.slice("space:".length);
      send("collab:open", { space, noteId: noteId.value });
      return;
    }
    if (!message.type?.startsWith("collab:")) return;
    if (message.ok === false) {
      lastError.value = message.error?.message || "The live session request failed.";
      if (message.type === "collab:open") status.value = "idle";
      else if (message.error?.code !== "SESSION_BUSY") status.value = "dropped";
      return;
    }
    const payload = message.payload || {};
    if (payload.sessionId && sessionId.value && payload.sessionId !== sessionId.value) return;
    switch (message.type) {
      case "collab:state": installState(payload); break;
      case "collab:update":
        if (ydoc.value && payload.update) Y.applyUpdate(ydoc.value, decode(payload.update), "remote");
        break;
      case "collab:ack": acknowledge(payload.seq); break;
      case "collab:participants": participants.value = payload.participants || []; break;
      case "collab:awareness": {
        const member = participants.value.find((participant) => participant.id === payload.from);
        if (member) member.idle = Boolean(payload.idle);
        participants.value = [...participants.value];
        break;
      }
      case "collab:committing": status.value = "committing"; break;
      case "collab:committed":
        status.value = "live";
        if (payload.result === "conflict") {
          conflictHunks.value = payload.conflicts || [];
          conflict.value = {
            baseContent: payload.baseContent || "",
            mineContent: payload.mineContent || "",
            theirsContent: payload.theirsContent || "",
            updatedAt: payload.at,
            mergeAttempts: 1,
          };
          lastError.value = "This version conflicts with an edit made outside the session.";
        } else {
          conflictHunks.value = [];
          conflict.value = null;
          useUiStore().addToast(`${payload.by?.name || "A member"} saved a document version.`, "success");
        }
        break;
      case "collab:closed": void finishSession(payload.reason); break;
      default: break;
    }
  }

  function start() {
    if (!removeSocketListener) removeSocketListener = syncStore.addWebSocketListener(handleMessage);
    syncStore.setCollabRemoteGuard((candidateDbKey, candidateNoteId) => (
      isActive.value && candidateDbKey === dbKey.value && candidateNoteId === noteId.value
    ));
  }

  function saveVersion() {
    flushUpdates();
    if (!sessionId.value || pending.size) {
      lastError.value = "Waiting for your latest changes to be stored before saving a version.";
      return false;
    }
    status.value = "committing";
    send("collab:commit", { sessionId: sessionId.value });
    return true;
  }

  function leave() {
    if (sessionId.value) send("collab:leave", { sessionId: sessionId.value });
    reset();
  }

  function sendAwareness({ cursor, selection, idle = false } = {}) {
    const now = Date.now();
    if (!sessionId.value || now - lastAwarenessAt < 100) return;
    lastAwarenessAt = now;
    send("collab:awareness", { sessionId: sessionId.value, cursor, selection, idle });
  }

  function resolveConflict(content) {
    if (!ydoc.value || status.value === "dropped") return false;
    const text = ydoc.value.getText("content");
    ydoc.value.transact(() => {
      if (text.length) text.delete(0, text.length);
      if (content) text.insert(0, content);
    }, localOrigin);
    conflict.value = null;
    conflictHunks.value = [];
    lastError.value = null;
    status.value = "live";
    return true;
  }

  function destroy() {
    leave();
    removeSocketListener?.();
    removeSocketListener = null;
    syncStore.setCollabRemoteGuard(null);
  }

  start();
  return {
    status, sessionId, dbKey, noteId, participants, lastError, conflictHunks, conflict,
    ydoc, localOrigin, isActive, isEditable, unackedCount,
    open, saveVersion, leave, destroy, handleMessage, resolveConflict, sendAwareness,
  };
});
