import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useAuthStore } from './authStore';
import { DATABASE_KINDS, parseDatabaseKey } from '@/utils/databaseKey';

const isProd = import.meta.env.PROD;
const API_URL = isProd ? '/api' : (import.meta.env.VITE_API_SERVICE_URL || 'http://localhost:8000');

function toQuery(params) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  });
  return query.toString();
}

function revisionUrl(dbKey, noteId, suffix = '', params = {}) {
  const parsed = parseDatabaseKey(dbKey);
  const query = toQuery({
    ...params,
    ...(parsed.kind === DATABASE_KINDS.SPACE ? { space: parsed.id } : {}),
  });
  return `${API_URL}/notes/${noteId}/revisions${suffix}${query ? `?${query}` : ''}`;
}

export const useRevisionStore = defineStore('revisionStore', () => {
  const revisions = ref([]);
  const selectedRevisionId = ref(null);
  const selectedRevisionCacheKey = ref(null);
  const revisionDetailCache = ref({});

  const isListLoading = ref(false);
  const listError = ref('');
  const isDetailLoading = ref(false);
  const detailError = ref('');
  const isActionLoading = ref(false);

  const hasMore = ref(false);
  const lastCursor = ref({ before: null, beforeId: null });

  const selectedRevision = computed(() => {
    if (!selectedRevisionId.value) return null;
    return revisions.value.find((item) => item.id === selectedRevisionId.value) || null;
  });

  const selectedRevisionDetail = computed(() => {
    if (!selectedRevisionCacheKey.value) return null;
    return revisionDetailCache.value[selectedRevisionCacheKey.value] || null;
  });

  function getAuthHeaders() {
    const auth = useAuthStore();
    return {
      Authorization: `Bearer ${auth.token || ''}`,
      'Content-Type': 'application/json',
    };
  }

  function resetState() {
    revisions.value = [];
    selectedRevisionId.value = null;
    selectedRevisionCacheKey.value = null;
    revisionDetailCache.value = {};
    listError.value = '';
    detailError.value = '';
    hasMore.value = false;
    lastCursor.value = { before: null, beforeId: null };
  }

  async function fetchRevisions(dbKey, noteId, { reset = true, limit = 50 } = {}) {
    parseDatabaseKey(dbKey);
    if (!noteId) return;

    if (reset) {
      revisions.value = [];
      selectedRevisionId.value = null;
      selectedRevisionCacheKey.value = null;
      revisionDetailCache.value = {};
      lastCursor.value = { before: null, beforeId: null };
      hasMore.value = false;
    }

    isListLoading.value = true;
    listError.value = '';

    try {
      const url = revisionUrl(dbKey, noteId, '', {
        limit,
        before: reset ? null : lastCursor.value.before,
        beforeId: reset ? null : lastCursor.value.beforeId,
      });

      const response = await fetch(url, {
        headers: getAuthHeaders(),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to load revisions');
      }

      const incoming = Array.isArray(data.revisions) ? data.revisions : [];
      revisions.value = reset ? incoming : [...revisions.value, ...incoming];

      hasMore.value = incoming.length === limit;
      if (revisions.value.length > 0) {
        const oldest = revisions.value[revisions.value.length - 1];
        lastCursor.value = {
          before: oldest.createdAt,
          beforeId: oldest.id,
        };
      }
    } catch (error) {
      listError.value = error.message || 'Failed to load revisions';
      throw error;
    } finally {
      isListLoading.value = false;
    }
  }

  async function loadMore(dbKey, noteId, limit = 50) {
    if (!hasMore.value || isListLoading.value) return;
    return fetchRevisions(dbKey, noteId, { reset: false, limit });
  }

  async function fetchRevisionDetail(dbKey, noteId, revisionId) {
    parseDatabaseKey(dbKey);
    if (!noteId || !revisionId) return null;
    const cacheKey = JSON.stringify([dbKey, noteId, revisionId]);
    if (revisionDetailCache.value[cacheKey]) {
      selectedRevisionId.value = revisionId;
      selectedRevisionCacheKey.value = cacheKey;
      return revisionDetailCache.value[cacheKey];
    }

    isDetailLoading.value = true;
    detailError.value = '';
    selectedRevisionId.value = revisionId;
    selectedRevisionCacheKey.value = cacheKey;

    try {
      const response = await fetch(revisionUrl(dbKey, noteId, `/${revisionId}`), {
        headers: getAuthHeaders(),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to load revision');
      }

      revisionDetailCache.value = {
        ...revisionDetailCache.value,
        [cacheKey]: data.revision,
      };

      return data.revision;
    } catch (error) {
      detailError.value = error.message || 'Failed to load revision';
      throw error;
    } finally {
      isDetailLoading.value = false;
    }
  }

  async function saveManualRevision(dbKey, noteId) {
    parseDatabaseKey(dbKey);
    if (!noteId) return { created: false };

    isActionLoading.value = true;
    try {
      const response = await fetch(revisionUrl(dbKey, noteId), {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({}),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save version');
      }

      await fetchRevisions(dbKey, noteId, { reset: true, limit: 50 });
      return data;
    } finally {
      isActionLoading.value = false;
    }
  }

  async function restoreRevision(dbKey, noteId, revisionId, expectedUpdatedAt = null) {
    parseDatabaseKey(dbKey);
    if (!noteId || !revisionId) return null;

    isActionLoading.value = true;
    try {
      const response = await fetch(revisionUrl(dbKey, noteId, `/${revisionId}/restore`), {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to restore revision');
      }

      await fetchRevisions(dbKey, noteId, { reset: true, limit: 50 });
      if (selectedRevisionId.value && !revisions.value.some((item) => item.id === selectedRevisionId.value)) {
        selectedRevisionId.value = null;
      }

      return data;
    } finally {
      isActionLoading.value = false;
    }
  }

  return {
    revisions,
    selectedRevisionId,
    selectedRevision,
    selectedRevisionDetail,
    isListLoading,
    listError,
    isDetailLoading,
    detailError,
    isActionLoading,
    hasMore,
    resetState,
    fetchRevisions,
    loadMore,
    fetchRevisionDetail,
    saveManualRevision,
    restoreRevision,
  };
});
