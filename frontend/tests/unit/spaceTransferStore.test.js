import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, defineStore, setActivePinia } from "pinia";
import { ref } from "vue";

const sync = vi.fn(async () => {});
const refreshToken = vi.fn(async () => false);

vi.mock("@/store/authStore", () => ({
  useAuthStore: defineStore("authStore", () => ({
    token: ref("token"),
    refreshToken,
  })),
}));

vi.mock("@/store/syncStore", () => ({
  useSyncStore: defineStore("syncStore", () => ({ sync })),
}));

const { useSpaceTransferStore } = await import("@/store/spaceTransferStore.js");

describe("spaceTransferStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("requires an explicit confirmation before creating and syncing a transfer", async () => {
    const transfer = {
      id: "transfer-a",
      status: "complete",
      warnings: [],
      revisionHistoryTransferred: false,
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ transfer }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ transfers: [] }) }));
    const store = useSpaceTransferStore();
    store.begin({
      sourceDbKey: "user:11111111-1111-4111-8111-111111111111",
      destinationDbKey: "space:22222222-2222-4222-8222-222222222222",
      sourceNoteId: "33333333-3333-4333-8333-333333333333",
      destinationFolderId: null,
      documentName: "Plan",
    });

    expect(fetch).not.toHaveBeenCalled();
    await expect(store.confirm()).resolves.toEqual(transfer);
    expect(fetch).toHaveBeenNthCalledWith(1, expect.stringContaining("/space-transfers"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"sourceNoteId":"33333333-3333-4333-8333-333333333333"'),
      }));
    expect(sync).toHaveBeenCalledOnce();
    expect(store.pending).toBeNull();
  });

  it("keeps interrupted transfers visible with all recovery actions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        transfers: [{ id: "transfer-a", status: "recoverable_duplicate" }],
      }),
    }));
    const store = useSpaceTransferStore();

    await store.loadRecoverable();

    expect(store.recoverable).toEqual([
      expect.objectContaining({ id: "transfer-a", status: "recoverable_duplicate" }),
    ]);
    expect(typeof store.retry).toBe("function");
    expect(typeof store.keepBoth).toBe("function");
    expect(typeof store.deleteSource).toBe("function");
  });
});
