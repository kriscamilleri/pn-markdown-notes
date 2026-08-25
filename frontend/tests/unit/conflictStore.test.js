// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

let syncStore;
let database;
const DB_KEY = "user:11111111-1111-4111-8111-111111111111";

vi.mock("../../src/store/syncStore.js", () => ({
    useSyncStore: () => syncStore,
}));

import { useConflictStore } from "../../src/store/conflictStore.js";

describe("conflictStore (COLLAB-02 §6.2)", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.restoreAllMocks();
        database = {
            exec: vi.fn(async () => undefined),
            execO: vi.fn(async () => [{ updated_at: "2026-08-16T20:00:00.000Z", merge_attempts: 2 }]),
        };
        syncStore = {
            isInitialized: true,
            databases: new Map([[DB_KEY, { dbKey: DB_KEY, db: database }]]),
            execute: vi.fn(async (sql) => {
                if (sql.includes("base_content")) {
                    return [{
                        note_id: "note-a",
                        base_content: "base",
                        mine_content: "mine",
                        theirs_content: "theirs",
                        conflict_hunks: JSON.stringify([{ baseLines: ["base"], mineLines: ["mine"], theirsLines: ["theirs"] }]),
                        created_at: "2026-08-16T19:00:00.000Z",
                        updated_at: "2026-08-16T20:00:00.000Z",
                        merge_attempts: 2,
                    }];
                }
                if (sql.includes("note_conflicts")) {
                    return [
                        { note_id: "note-a" },
                        { note_id: "note-b" },
                    ];
                }
                return [];
            }),
            repository: () => ({
                execute: (sql, params) => sql.includes("SELECT updated_at")
                    ? database.execO(sql, params)
                    : syncStore.execute(sql, params),
                transaction: async (work) => {
                    await database.exec("BEGIN");
                    try {
                        const result = await work({
                            execute: (sql, params) => database.execO(sql, params),
                            exec: (sql, params) => database.exec(sql, params),
                        });
                        await database.exec("COMMIT");
                        return result;
                    } catch (error) {
                        await database.exec("ROLLBACK");
                        throw error;
                    }
                },
            }),
        };
    });

    it("loads the set of conflicted note ids", async () => {
        const store = useConflictStore();
        await store.loadConflicts();
        expect(store.count).toBe(2);
        expect(store.hasConflict("note-a", DB_KEY)).toBe(true);
        expect(store.hasConflict("note-b", DB_KEY)).toBe(true);
        expect(store.hasConflict("note-c", DB_KEY)).toBe(false);
    });

    it("treats an empty result as no conflicts", async () => {
        syncStore.execute = vi.fn(async () => []);
        const store = useConflictStore();
        await store.loadConflicts();
        expect(store.count).toBe(0);
        expect(store.hasConflict("note-a", DB_KEY)).toBe(false);
    });

    it("loads and normalizes one complete conflict lazily", async () => {
        const store = useConflictStore();
        const conflict = await store.loadConflict("note-a", DB_KEY);

        expect(syncStore.execute).toHaveBeenCalledWith(expect.stringContaining("WHERE note_id = ?"), ["note-a"]);
        expect(conflict).toMatchObject({
            noteId: "note-a",
            dbKey: DB_KEY,
            baseContent: "base",
            mineContent: "mine",
            theirsContent: "theirs",
            mergeAttempts: 2,
        });
        expect(conflict.conflictHunks).toHaveLength(1);
    });

    it("treats malformed serialized hunks as recoverable detail state", async () => {
        syncStore.execute = vi.fn(async (sql) => sql.includes("base_content") ? [{
            note_id: "note-a",
            base_content: "base",
            mine_content: "mine",
            theirs_content: "theirs",
            conflict_hunks: "not json",
            updated_at: "stamp",
            merge_attempts: 1,
        }] : []);
        const store = useConflictStore();
        const conflict = await store.loadConflict("note-a", DB_KEY);
        expect(conflict.conflictHunks).toEqual([]);
    });

    it("atomically writes the resolution, resets the guard, and removes the marker", async () => {
        const store = useConflictStore();
        await store.loadConflicts();
        const conflict = await store.loadConflict("note-a", DB_KEY);

        await store.resolveConflict(conflict, "resolved");

        const calls = database.exec.mock.calls.map(([sql]) => sql.trim());
        expect(calls[0]).toBe("BEGIN");
        expect(calls.some((sql) => sql.startsWith("UPDATE notes SET content"))).toBe(true);
        expect(calls.some((sql) => sql.includes("writeback_count = 0"))).toBe(true);
        expect(calls.some((sql) => sql.startsWith("DELETE FROM note_conflicts"))).toBe(true);
        expect(calls.at(-1)).toBe("COMMIT");
        expect(store.hasConflict("note-a", DB_KEY)).toBe(false);
    });

    it("rolls back and keeps the marker when the reviewed record is stale", async () => {
        const store = useConflictStore();
        await store.loadConflicts();
        const conflict = await store.loadConflict("note-a", DB_KEY);
        database.execO.mockResolvedValueOnce([{ updated_at: "newer", merge_attempts: 3 }]);

        await expect(store.resolveConflict(conflict, "resolved")).rejects.toMatchObject({ code: "CONFLICT_STALE" });
        expect(database.exec).toHaveBeenLastCalledWith("ROLLBACK");
        expect(store.hasConflict("note-a", DB_KEY)).toBe(true);
        expect(database.exec.mock.calls.some(([sql]) => sql.includes("UPDATE notes"))).toBe(false);
    });

    it("rolls back if any resolution write fails", async () => {
        const store = useConflictStore();
        await store.loadConflicts();
        const conflict = await store.loadConflict("note-a", DB_KEY);
        database.exec.mockImplementation(async (sql) => {
            if (sql.includes("note_sync_base")) throw new Error("base write failed");
        });

        await expect(store.resolveConflict(conflict, "resolved")).rejects.toThrow("base write failed");
        expect(database.exec).toHaveBeenLastCalledWith("ROLLBACK");
        expect(store.hasConflict("note-a", DB_KEY)).toBe(true);
    });

    it("clears all conflicts", async () => {
        const store = useConflictStore();
        await store.loadConflicts();
        expect(store.count).toBe(2);
        store.clearAll();
        expect(store.count).toBe(0);
    });
});
