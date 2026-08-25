import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { useSyncStore } from './syncStore';

/**
 * View and resolution actions for the client-local `note_conflicts` table
 * (COLLAB-02). Summary state stays lightweight for document-list markers;
 * complete conflict bodies are loaded only when the editor opens a resolver.
 */
export const useConflictStore = defineStore('conflictStore', () => {
    const syncStore = useSyncStore();
    const conflictedNoteIds = ref(new Set());

    const count = computed(() => conflictedNoteIds.value.size);

    const conflictKey = (dbKey, noteId) => `${dbKey}:${noteId}`;

    async function loadConflicts() {
        if (!syncStore.isInitialized) {
            conflictedNoteIds.value = new Set();
            return;
        }
        const ids = new Set();
        for (const entry of syncStore.databases.values()) {
            if (!entry.db) continue;
            const rows = await syncStore.repository(entry.dbKey).execute('SELECT note_id FROM note_conflicts');
            for (const row of rows || []) ids.add(conflictKey(entry.dbKey, row.note_id));
        }
        conflictedNoteIds.value = ids;
    }

    async function loadConflict(noteId, dbKey) {
        if (!noteId || !syncStore.isInitialized) return null;
        if (!dbKey) throw new Error('Database scope is required to load a conflict.');
        const rows = await syncStore.repository(dbKey).execute(
            `SELECT note_id, base_content, mine_content, theirs_content,
                    conflict_hunks, created_at, updated_at, merge_attempts
             FROM note_conflicts
             WHERE note_id = ?`,
            [noteId],
        );
        const row = rows?.[0];
        if (!row) return null;

        let conflictHunks = [];
        try {
            const parsed = JSON.parse(row.conflict_hunks || '[]');
            conflictHunks = Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.warn('[conflictStore] Rebuilding malformed conflict hunks from stored bodies.', error);
        }

        return {
            noteId: row.note_id,
            dbKey,
            baseContent: row.base_content ?? '',
            mineContent: row.mine_content ?? '',
            theirsContent: row.theirs_content ?? '',
            conflictHunks,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            mergeAttempts: Number(row.merge_attempts ?? 0),
        };
    }

    async function resolveConflict(conflict, content) {
        if (!conflict?.noteId) throw new Error('A conflict record is required.');
        if (!conflict.dbKey) throw new Error('Database scope is required to resolve a conflict.');

        const now = new Date().toISOString();
        await syncStore.repository(conflict.dbKey).transaction(async (repo) => {
            const currentRows = await repo.execute(
                'SELECT updated_at, merge_attempts FROM note_conflicts WHERE note_id = ?',
                [conflict.noteId],
            );
            const current = currentRows?.[0];
            if (
                !current ||
                current.updated_at !== conflict.updatedAt ||
                Number(current.merge_attempts ?? 0) !== Number(conflict.mergeAttempts ?? 0)
            ) {
                const error = new Error('Newer changes arrived. Review the updated regions before applying.');
                error.code = 'CONFLICT_STALE';
                throw error;
            }

            await repo.exec(
                'UPDATE notes SET content = ?, updated_at = ? WHERE id = ?',
                [content ?? '', now, conflict.noteId],
            );
            await repo.exec(
                `INSERT INTO note_sync_base
                   (note_id, content, writeback_count, writeback_window_started_at, updated_at)
                 VALUES (?, ?, 0, NULL, ?)
                 ON CONFLICT(note_id) DO UPDATE SET
                   content = excluded.content,
                   writeback_count = 0,
                   writeback_window_started_at = NULL,
                   updated_at = excluded.updated_at`,
                [conflict.noteId, content ?? '', now],
            );
            await repo.exec('DELETE FROM note_conflicts WHERE note_id = ?', [conflict.noteId]);
        });

        const nextIds = new Set(conflictedNoteIds.value);
        nextIds.delete(conflictKey(conflict.dbKey, conflict.noteId));
        conflictedNoteIds.value = nextIds;
    }

    function hasConflict(noteId, dbKey) {
        if (!dbKey) return false;
        return conflictedNoteIds.value.has(conflictKey(dbKey, noteId));
    }

    function clearAll() {
        conflictedNoteIds.value = new Set();
    }

    function clearDatabase(dbKey) {
        conflictedNoteIds.value = new Set(
            [...conflictedNoteIds.value].filter((key) => !key.startsWith(`${dbKey}:`)),
        );
    }

    watch(
        () => syncStore.isInitialized,
        async (ready) => {
            if (ready) await loadConflicts();
        },
    );

    return {
        conflictedNoteIds,
        count,
        loadConflicts,
        loadConflict,
        resolveConflict,
        hasConflict,
        clearDatabase,
        clearAll,
    };
});
