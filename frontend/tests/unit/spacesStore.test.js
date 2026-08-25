// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const SPACE_ID = "22222222-2222-4222-8222-222222222222";
const SPACE_KEY = `space:${SPACE_ID}`;
const order = [];
const harness = vi.hoisted(() => ({
  auth: {
    token: "token",
    refreshToken: vi.fn(async () => false),
  },
  sync: {
    databases: new Map(),
    requestMembershipRefresh: vi.fn(async () => {}),
    removeDatabase: vi.fn(async () => {}),
  },
}));

vi.mock("@/store/authStore", () => ({ useAuthStore: () => harness.auth }));
vi.mock("@/store/syncStore", () => ({ useSyncStore: () => harness.sync }));

const { useSpacesStore } = await import("@/store/spacesStore");

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  order.length = 0;
  harness.auth.token = "token";
  harness.auth.refreshToken.mockReset().mockResolvedValue(false);
  harness.sync.databases = new Map([[SPACE_KEY, {
    dbKey: SPACE_KEY,
    kind: "space",
    name: "Writers",
    role: "owner",
    members: [{ id: "owner", name: "Owner" }],
    status: "ready",
  }]]);
  harness.sync.requestMembershipRefresh.mockReset().mockImplementation(async () => {
    order.push("refresh");
  });
  harness.sync.removeDatabase.mockReset().mockImplementation(async () => {
    order.push("remove");
  });
});

describe("spacesStore", () => {
  it("derives space summaries from the registry and loads owner detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, {
      space: { id: SPACE_ID, name: "Writers", role: "owner" },
      members: [],
      invitations: [],
    })));
    const store = useSpacesStore();
    expect(store.spaces).toEqual([
      expect.objectContaining({ id: SPACE_ID, name: "Writers", role: "owner" }),
    ]);
    await store.loadDetail(SPACE_ID);
    expect(store.detail.space.role).toBe("owner");
  });

  it("sends editor-only invitations and refreshes authoritative registry/detail state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(201, {
        invitation: { id: "invite" },
        invitationUrl: "https://panino.test/#/spaces/invitations/token",
        emailSent: true,
      }))
      .mockResolvedValueOnce(response(200, {
        space: { id: SPACE_ID, name: "Writers", role: "owner" },
        members: [],
        invitations: [{ id: "invite", email: "editor@example.test" }],
      }));
    vi.stubGlobal("fetch", fetchMock);
    const store = useSpacesStore();
    const result = await store.invite(SPACE_ID, "editor@example.test");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      email: "editor@example.test",
      role: "editor",
    });
    expect(harness.sync.requestMembershipRefresh).toHaveBeenCalledOnce();
    expect(store.detail.invitations).toHaveLength(1);
    expect(result.invitationUrl).toBe("https://panino.test/#/spaces/invitations/token");
  });

  it("loads invitations for the current account and refreshes them after acceptance", async () => {
    const invitation = {
      id: "33333333-3333-4333-8333-333333333333",
      spaceName: "Editorial",
      role: "editor",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { invitations: [invitation] }))
      .mockResolvedValueOnce(response(200, { accepted: true, spaceId: SPACE_ID }))
      .mockResolvedValueOnce(response(200, { invitations: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const store = useSpacesStore();

    await store.loadPendingInvitations();
    expect(store.pendingInvitations).toEqual([invitation]);
    const accepted = await store.acceptPendingInvitation(invitation.id);

    expect(fetchMock.mock.calls[1][0]).toContain(
      `/space-invitations/${invitation.id}/accept`,
    );
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
    expect(accepted).toMatchObject({ accepted: true, spaceId: SPACE_ID });
    expect(store.pendingInvitations).toEqual([]);
    expect(harness.sync.requestMembershipRefresh).toHaveBeenCalledOnce();
  });

  it("removes the revoked local scope before refreshing after leave", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 204 })));
    const store = useSpacesStore();
    await store.leaveSpace(SPACE_ID);
    expect(order).toEqual(["remove", "refresh"]);
    expect(harness.sync.removeDatabase).toHaveBeenCalledWith(
      SPACE_KEY,
      { notifyServer: false },
    );
  });

  it("retries one unauthorized request after refreshing the token", async () => {
    harness.auth.refreshToken.mockResolvedValue(true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(401, { error: "expired" }))
      .mockResolvedValueOnce(response(200, {
        space: { id: SPACE_ID, name: "Writers", role: "owner" },
        members: [],
        invitations: [],
      }));
    vi.stubGlobal("fetch", fetchMock);
    await useSpacesStore().loadDetail(SPACE_ID);
    expect(harness.auth.refreshToken).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps raw server failures to stable product copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(404, {
      error: "raw membership detail",
      code: "SPACE_NOT_FOUND",
    })));
    const store = useSpacesStore();
    await expect(store.loadDetail(SPACE_ID)).rejects.toThrow(/unavailable/);
    expect(store.error).not.toContain("membership");
  });
});
