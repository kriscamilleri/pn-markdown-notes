// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as Y from "yjs";

const harness = vi.hoisted(() => ({
  listeners: new Set(),
  sent: [],
  guard: null,
  online: true,
  refreshData: vi.fn(async () => {}),
  sync: vi.fn(async () => {}),
  toast: vi.fn(),
}));

vi.mock("@/store/syncStore", () => ({
  useSyncStore: () => ({
    get isOnline() { return harness.online; },
    addWebSocketListener(listener) { harness.listeners.add(listener); return () => harness.listeners.delete(listener); },
    setCollabRemoteGuard(guard) { harness.guard = guard; },
    sendWebSocketMessage(type, payload) { harness.sent.push({ type, payload }); return crypto.randomUUID(); },
    sync: harness.sync,
  }),
}));
vi.mock("@/store/docStore", () => ({ useDocStore: () => ({ refreshData: harness.refreshData }) }));
vi.mock("@/store/uiStore", () => ({ useUiStore: () => ({ addToast: harness.toast }) }));

const { useCollabSessionStore } = await import("@/store/collabSessionStore");
const SPACE = "22222222-2222-4222-8222-222222222222";
const NOTE = "33333333-3333-4333-8333-333333333333";

function encodedState(value) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, value);
  let binary = "";
  for (const byte of Y.encodeStateAsUpdate(doc)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

beforeEach(() => {
  setActivePinia(createPinia());
  harness.listeners.clear();
  harness.sent = [];
  harness.guard = null;
  harness.online = true;
  vi.clearAllMocks();
});

describe("live session state machine", () => {
  it("joins explicitly, batches local updates, and discards only acknowledged operations", async () => {
    vi.useFakeTimers();
    const store = useCollabSessionStore();
    expect(store.open(SPACE, NOTE)).toBe(true);
    expect(store.status).toBe("opening");
    store.handleMessage({ type: "collab:state", ok: true, payload: {
      sessionId: "session-a", update: encodedState("base"), participants: [{ id: "a", name: "Alice" }], ack: 0,
    } });
    expect(store.status).toBe("live");
    store.ydoc.transact(() => store.ydoc.getText("content").insert(4, " edit"), store.localOrigin);
    expect(store.unackedCount).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    const update = harness.sent.find((message) => message.type === "collab:update");
    expect(update.payload.seq).toBe(1);
    store.handleMessage({ type: "collab:ack", ok: true, payload: { sessionId: "session-a", seq: 1 } });
    expect(store.unackedCount).toBe(0);
    vi.useRealTimers();
  });

  it("reopens after a socket drop and becomes visibly read-only after the hard timeout", async () => {
    vi.useFakeTimers();
    const store = useCollabSessionStore();
    store.open(SPACE, NOTE);
    store.handleMessage({ type: "collab:state", ok: true, payload: {
      sessionId: "session-a", update: encodedState("base"), participants: [], ack: 0,
    } });
    store.handleMessage({ type: "socket:close" });
    expect(store.status).toBe("reconnecting");
    store.handleMessage({ type: "socket:open" });
    expect(harness.sent.at(-1)).toMatchObject({ type: "collab:open", payload: { space: SPACE, noteId: NOTE } });
    store.handleMessage({ type: "socket:close" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.status).toBe("dropped");
    expect(store.isEditable).toBe(false);
    vi.useRealTimers();
  });

  it("owns in-session sync handoff without replacing Y.Text or opening a normal conflict", () => {
    const store = useCollabSessionStore();
    store.open(SPACE, NOTE);
    store.handleMessage({ type: "collab:state", ok: true, payload: {
      sessionId: "session-a", update: encodedState("live text"), participants: [], ack: 0,
    } });
    expect(harness.guard(`space:${SPACE}`, NOTE, "server text")).toBe(true);
    expect(store.ydoc.getText("content").toString()).toBe("live text");
    expect(harness.guard(`space:${SPACE}`, "different", "server text")).toBe(false);
  });

  it("continues participant sequences after a durable page-reload acknowledgement", async () => {
    vi.useFakeTimers();
    const store = useCollabSessionStore();
    store.open(SPACE, NOTE);
    store.handleMessage({ type: "collab:state", ok: true, payload: {
      sessionId: "session-a", update: encodedState("base"), participants: [], ack: 7,
    } });
    store.ydoc.transact(() => store.ydoc.getText("content").insert(4, " next"), store.localOrigin);
    await vi.advanceTimersByTimeAsync(50);
    expect(harness.sent.find((message) => message.type === "collab:update")?.payload.seq).toBe(8);
    vi.useRealTimers();
  });
});
