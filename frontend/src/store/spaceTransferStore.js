import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { useAuthStore } from "./authStore";
import { useSyncStore } from "./syncStore";

const API_URL = import.meta.env.PROD
  ? "/api"
  : (import.meta.env.VITE_API_SERVICE_URL || "http://localhost:8000");

export const useSpaceTransferStore = defineStore("spaceTransferStore", () => {
  const authStore = useAuthStore();
  const syncStore = useSyncStore();
  const pending = ref(null);
  const transfers = ref([]);
  const working = ref(false);
  const error = ref("");

  const recoverable = computed(() => transfers.value.filter(
    (transfer) => !["complete", "kept_both"].includes(transfer.status),
  ));

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
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = new Error(data?.error || "Transfer interrupted; retry is safe.");
      failure.code = data?.code || "TRANSFER_FAILED";
      throw failure;
    }
    return data;
  }

  function begin(details) {
    error.value = "";
    pending.value = { ...details };
  }

  function cancel() {
    if (!working.value) pending.value = null;
  }

  async function refreshLocalDatabases() {
    await syncStore.sync();
  }

  async function loadRecoverable() {
    try {
      transfers.value = (await request("/space-transfers")).transfers || [];
    } catch (failure) {
      error.value = failure.message;
    }
    return recoverable.value;
  }

  async function confirm() {
    if (!pending.value || working.value) return null;
    working.value = true;
    error.value = "";
    try {
      const data = await request("/space-transfers", {
        method: "POST",
        body: JSON.stringify({
          sourceDbKey: pending.value.sourceDbKey,
          destinationDbKey: pending.value.destinationDbKey,
          sourceNoteId: pending.value.sourceNoteId,
          destinationFolderId: pending.value.destinationFolderId,
        }),
      });
      pending.value = null;
      await refreshLocalDatabases();
      await loadRecoverable();
      return data.transfer;
    } catch (failure) {
      error.value = failure.message;
      await loadRecoverable();
      throw failure;
    } finally {
      working.value = false;
    }
  }

  async function act(transferId, action) {
    working.value = true;
    error.value = "";
    try {
      const data = await request(
        `/space-transfers/${encodeURIComponent(transferId)}/${action}`,
        { method: "POST" },
      );
      await refreshLocalDatabases();
      await loadRecoverable();
      return data.transfer;
    } catch (failure) {
      error.value = failure.message;
      await loadRecoverable();
      throw failure;
    } finally {
      working.value = false;
    }
  }

  return {
    pending,
    transfers,
    recoverable,
    working,
    error,
    begin,
    cancel,
    confirm,
    loadRecoverable,
    retry: (id) => act(id, "retry"),
    keepBoth: (id) => act(id, "keep-both"),
    deleteSource: (id) => act(id, "delete-source"),
  };
});
