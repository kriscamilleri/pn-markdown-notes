import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { useAuthStore } from "./authStore";
import { useSyncStore } from "./syncStore";
import { createDatabaseKey, parseDatabaseKey } from "@/utils/databaseKey";
import { spaceErrorMessage } from "@/utils/spaceLifecycle";

const API_URL = import.meta.env.PROD
  ? "/api"
  : (import.meta.env.VITE_API_SERVICE_URL || "http://localhost:8000");

export const useSpacesStore = defineStore("spacesStore", () => {
  const detail = ref(null);
  const loading = ref(false);
  const error = ref("");
  const pendingInvitations = ref([]);
  const pendingInvitationsLoading = ref(false);
  const pendingInvitationsError = ref("");
  const syncStore = useSyncStore();
  const authStore = useAuthStore();

  const spaces = computed(() => [...syncStore.databases.values()]
    .filter((entry) => entry.kind === "space")
    .map((entry) => ({
      id: parseDatabaseKey(entry.dbKey).id,
      dbKey: entry.dbKey,
      name: entry.name,
      role: entry.role,
      members: entry.members || [],
      status: entry.status,
    }))
    .sort((a, b) => a.name.localeCompare(b.name)));

  async function request(path, options = {}, allowRetry = true) {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${authStore.token || ""}`,
        ...(options.headers || {}),
      },
    });
    if (response.status === 401 && allowRetry && await authStore.refreshToken()) {
      return request(path, options, false);
    }
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = new Error(spaceErrorMessage(data?.code));
      failure.code = data?.code || "SPACE_OPERATION_FAILED";
      failure.status = response.status;
      throw failure;
    }
    return data;
  }

  async function refreshRegistry() {
    await syncStore.requestMembershipRefresh();
  }

  /** Loads invitations addressed to the signed-in account without exposing raw tokens. */
  async function loadPendingInvitations() {
    pendingInvitationsLoading.value = true;
    pendingInvitationsError.value = "";
    try {
      const result = await request("/space-invitations");
      pendingInvitations.value = result.invitations || [];
      return pendingInvitations.value;
    } catch (failure) {
      pendingInvitationsError.value = failure.message;
      throw failure;
    } finally {
      pendingInvitationsLoading.value = false;
    }
  }

  async function loadDetail(spaceId) {
    loading.value = true;
    error.value = "";
    try {
      detail.value = await request(`/spaces/${encodeURIComponent(spaceId)}`);
      return detail.value;
    } catch (failure) {
      error.value = failure.message;
      detail.value = null;
      throw failure;
    } finally {
      loading.value = false;
    }
  }

  async function createSpace(name) {
    const result = await request("/spaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    await refreshRegistry();
    return result.space;
  }

  async function renameSpace(spaceId, name) {
    await request(`/spaces/${encodeURIComponent(spaceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    await refreshRegistry();
    return loadDetail(spaceId);
  }

  async function invite(spaceId, email) {
    const result = await request(`/spaces/${encodeURIComponent(spaceId)}/invitations`, {
      method: "POST",
      body: JSON.stringify({ email, role: "editor" }),
    });
    await refreshRegistry();
    await loadDetail(spaceId);
    return result;
  }

  async function revokeInvite(spaceId, inviteId) {
    await request(
      `/spaces/${encodeURIComponent(spaceId)}/invitations/${encodeURIComponent(inviteId)}`,
      { method: "DELETE" },
    );
    await refreshRegistry();
    return loadDetail(spaceId);
  }

  async function resendInvite(spaceId, inviteId) {
    const result = await request(
      `/spaces/${encodeURIComponent(spaceId)}/invitations/${encodeURIComponent(inviteId)}/resend`,
      { method: "POST" },
    );
    await refreshRegistry();
    await loadDetail(spaceId);
    return result;
  }

  async function removeMember(spaceId, userId) {
    await request(
      `/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
    await refreshRegistry();
    return loadDetail(spaceId);
  }

  async function transferOwnership(spaceId, userId) {
    await request(`/spaces/${encodeURIComponent(spaceId)}/ownership`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
    await refreshRegistry();
    return loadDetail(spaceId);
  }

  async function leaveSpace(spaceId) {
    await request(`/spaces/${encodeURIComponent(spaceId)}/leave`, { method: "POST" });
    await syncStore.removeDatabase(createDatabaseKey("space", spaceId), { notifyServer: false });
    await refreshRegistry();
    detail.value = null;
  }

  async function requestDeletion(spaceId) {
    const result = await request(
      `/spaces/${encodeURIComponent(spaceId)}/deletion-request`,
      { method: "POST" },
    );
    await syncStore.removeDatabase(createDatabaseKey("space", spaceId), { notifyServer: false });
    await refreshRegistry();
    detail.value = null;
    return result;
  }

  async function acceptInvitation(token) {
    const result = await request("/space-invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    await refreshRegistry();
    return result;
  }

  /** Accepts an invitation selected on Manage Spaces, then refreshes local discovery state. */
  async function acceptPendingInvitation(inviteId) {
    const result = await request(
      `/space-invitations/${encodeURIComponent(inviteId)}/accept`,
      { method: "POST" },
    );
    await refreshRegistry();
    await loadPendingInvitations();
    return result;
  }

  function clearDetail() {
    detail.value = null;
    error.value = "";
  }

  return {
    spaces,
    detail,
    loading,
    error,
    pendingInvitations,
    pendingInvitationsLoading,
    pendingInvitationsError,
    loadPendingInvitations,
    loadDetail,
    createSpace,
    renameSpace,
    invite,
    revokeInvite,
    resendInvite,
    removeMember,
    transferOwnership,
    leaveSpace,
    requestDeletion,
    acceptInvitation,
    acceptPendingInvitation,
    clearDetail,
  };
});
