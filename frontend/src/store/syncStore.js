// /frontend/src/store/syncStore.js
import { defineStore } from "pinia";
import { computed, markRaw, ref } from "vue";
import initWasm from "@/vendor/crsqlite-wasm/index.js";
import wasmUrl from "@/vendor/crsqlite-wasm/crsqlite.wasm?url";
import { useAuthStore } from "./authStore";
import { useDocStore } from "./docStore";
import { useDraftStore } from "./draftStore";
import { useGlobalVariablesStore } from "./globalVariablesStore";
import { parsePkId } from "@/utils/crsqlitePk";
import {
  resolveSyncMerge,
  evaluateWritebackGuard,
} from "@/utils/syncMerge";
import { serializeConflictHunks } from "@panino/content-merge";
import { v4 as uuidv4 } from "uuid";
import {
  clockStorageKey,
  isStorageQuotaError,
  migrateLegacyPersonalClock,
  projectSpaceOutgoingChanges,
  reconcileMembershipKeys,
  runSequentially,
} from "@/utils/syncRegistry";
import {
  createDatabaseKey,
  localDatabaseName,
  parseDatabaseKey,
} from "@/utils/databaseKey";
import { createScopedRepository } from "@/utils/scopedRepository";

const isProd = import.meta.env.PROD;
const API_URL = isProd
  ? "/api"
  : import.meta.env.VITE_API_SERVICE_URL || "http://localhost:8000";
const WS_URL = isProd
  ? window.location.origin.replace(/^http/, "ws") + "/ws/"
  : API_URL.replace(/^http/, "ws");

const DB_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY NOT NULL, name TEXT, email TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY NOT NULL, user_id TEXT, name TEXT, parent_id TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY NOT NULL, user_id TEXT, folder_id TEXT, title TEXT, content TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY NOT NULL, user_id TEXT, filename TEXT, mime_type TEXT, path TEXT, size_bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '', created_at TEXT);
CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY NOT NULL, value TEXT);
CREATE TABLE IF NOT EXISTS globals (
  key TEXT PRIMARY KEY NOT NULL,
  id TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  display_key TEXT NOT NULL DEFAULT ''
);
SELECT crsql_as_crr('users');
SELECT crsql_as_crr('folders');
SELECT crsql_as_crr('notes');
SELECT crsql_as_crr('images');
SELECT crsql_as_crr('settings');
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  title_pattern TEXT NOT NULL DEFAULT '',
  default_folder_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_templates_updated ON templates(updated_at DESC);
SELECT crsql_as_crr('templates');

-- Local-only (non-CRR) client state for content merge (COLLAB-02). Deliberately
-- not replicated: note_sync_base tracks the last value this client and the
-- server agreed on, and note_conflicts holds displaced local bodies.
CREATE TABLE IF NOT EXISTS note_sync_base (
  note_id                     TEXT PRIMARY KEY NOT NULL,
  content                     TEXT NOT NULL DEFAULT '',
  writeback_count             INTEGER NOT NULL DEFAULT 0,
  writeback_window_started_at TEXT,
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS note_conflicts (
  note_id TEXT PRIMARY KEY NOT NULL,
  base_content TEXT NOT NULL DEFAULT '',
  mine_content TEXT NOT NULL DEFAULT '',
  theirs_content TEXT NOT NULL DEFAULT '',
  conflict_hunks TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  merge_attempts INTEGER NOT NULL DEFAULT 0
);
`;

function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export const useSyncStore = defineStore("syncStore", () => {
  const sqlite = ref(null);
  const databases = ref(new Map());
  const isInitialized = ref(false);
  const syncEnabled = ref(true);
  const isSyncing = ref(false);
  const ws = ref(null);
  const hasShownAuthWarning = ref(false);
  const isOnline = ref(navigator.onLine);

  // COLLAB-02 sync-merge state. Every registry entry owns its remote-apply and
  // queued-follow-up flags so databases cannot suppress one another.
  const contentMergeWriteback = ref(false);
  const membershipVersion = ref(0);
  const sharedSpacesAvailable = ref(false);
  const bootstrapState = ref({
    status: "idle",
    currentDbKey: null,
    completed: 0,
    total: 0,
    error: null,
  });
  const personalDbKey = computed(() => {
    const userId = useAuthStore().user?.id;
    return userId ? createDatabaseKey("user", userId) : null;
  });
  let membershipRefreshPromise = null;
  let membershipRefreshRequested = false;
  let reconnectTimer = null;
  let shouldReconnect = false;
  const webSocketListeners = new Set();
  let collabRemoteGuard = null;

  const debouncedSync = debounce(() => sync(), 500);

  function addWebSocketListener(listener) {
    webSocketListeners.add(listener);
    return () => webSocketListeners.delete(listener);
  }

  function notifyWebSocketListeners(message) {
    for (const listener of webSocketListeners) listener(message);
  }

  function sendWebSocketMessage(type, payload = {}) {
    if (ws.value?.readyState !== WebSocket.OPEN) return null;
    const requestId = uuidv4();
    ws.value.send(JSON.stringify({ v: 1, type, requestId, payload }));
    return requestId;
  }

  function setCollabRemoteGuard(guard) {
    collabRemoteGuard = typeof guard === "function" ? guard : null;
  }

  function getClock(dbKey) {
    return Number(localStorage.getItem(clockStorageKey(dbKey)) || 0);
  }
  function setClock(dbKey, value) {
    localStorage.setItem(clockStorageKey(dbKey), String(value));
    const entry = databases.value.get(dbKey);
    if (entry) entry.clock = Number(value) || 0;
  }

  function requireEntry(dbKey) {
    parseDatabaseKey(dbKey);
    const entry = databases.value.get(dbKey);
    if (!entry?.db) throw new Error(`Database scope ${dbKey} is not initialized.`);
    return entry;
  }

  function repository(dbKey) {
    return createScopedRepository(dbKey, (key) => databases.value.get(key)?.db || null);
  }

  function personalRepository() {
    if (!personalDbKey.value) throw new Error("Personal database scope is unavailable.");
    return repository(personalDbKey.value);
  }

  async function execute(dbKey, sql, params = []) {
    return repository(dbKey).execute(sql, params);
  }

  async function exec(dbKey, sql, params = []) {
    return repository(dbKey).exec(sql, params);
  }

  async function openDatabaseEntry({ dbKey, name, role = null, members = [] }) {
    const { kind } = parseDatabaseKey(dbKey);
    const database = markRaw(await sqlite.value.open(localDatabaseName(dbKey)));
    database.exec(DB_SCHEMA);
    await ensureNotesSchema(database);
    await ensureImagesSchema(database);
    await ensureGlobalsSchema(database);
    await ensureTemplatesSchema(database);

    const rows = await database.execO(`SELECT lower(hex(crsql_site_id())) AS id`);
    const siteId = rows[0]?.id;
    if (!/^[0-9a-f]{32}$/.test(siteId || "")) {
      await database.close();
      throw new Error(`Fatal: Could not retrieve crsql_site_id for ${dbKey}.`);
    }

    const entry = {
      dbKey,
      kind,
      db: database,
      siteId,
      clock: getClock(dbKey),
      name,
      role,
      members,
      isSyncing: false,
      isApplyingRemote: false,
      syncPending: false,
      status: "ready",
      error: null,
    };
    databases.value.set(dbKey, entry);
    database.onUpdate(() => {
      if (entry.isApplyingRemote) {
        entry.syncPending = true;
        return;
      }
      debouncedSync();
    });
    return entry;
  }

  async function initializeDB() {
    if (isInitialized.value) return;

    console.info("[syncStore] Initializing crsqlite wasm…");
    sqlite.value = markRaw(await initWasm(() => wasmUrl));

    const auth = useAuthStore();
    if (!auth.isAuthenticated || !auth.user?.id) {
      throw new Error("Authentication is required to initialize the personal database.");
    }
    const dbKey = createDatabaseKey("user", auth.user.id);
    migrateLegacyPersonalClock(localStorage, dbKey);
    await openDatabaseEntry({ dbKey, name: "Personal" });

    isInitialized.value = true;

    // Set up online/offline listeners
    setupOnlineOfflineListeners();
    shouldReconnect = true;
    connectWebSocket();

    // First paint is gated only by the personal database. Membership discovery
    // and space bootstrap deliberately continue in the background.
    queueMicrotask(() => {
      void refreshMembership({ bootstrap: true }).catch(reportMembershipRefreshFailure);
    });
  }

  async function ensureGlobalsSchema(database) {
    if (!database) throw new Error("Database scope is required for schema initialization.");
    try {
      const columns = await database.execO("PRAGMA table_info('globals')");
      if (!columns || columns.length === 0) {
        await database.exec(`
          CREATE TABLE IF NOT EXISTS globals (
            key TEXT PRIMARY KEY NOT NULL,
             id TEXT NOT NULL DEFAULT '',
            value TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            display_key TEXT NOT NULL DEFAULT ''
          )
        `);
        await database.exec("SELECT crsql_as_crr('globals')");
        return;
      }

      const names = new Set((columns || []).map((c) => c.name));
      const indexes = await database.execO("PRAGMA index_list('globals')");
      const hasExtraUnique = (indexes || []).some(
        (idx) => idx?.unique && idx?.origin !== "pk",
      );

      if (hasExtraUnique) {
        const selectId = names.has("id") ? "id" : "key";
        const selectCreated = names.has("created_at")
          ? "created_at"
          : "datetime('now')";
        const selectUpdated = names.has("updated_at")
          ? "updated_at"
          : "datetime('now')";
        const selectDisplay = names.has("display_key") ? "display_key" : "key";

        await database.exec("BEGIN");
        try {
          await database.exec(`
            CREATE TABLE globals_new (
              key TEXT PRIMARY KEY NOT NULL,
               id TEXT NOT NULL DEFAULT '',
              value TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              display_key TEXT NOT NULL DEFAULT ''
            )
          `);
          await database.exec(`
            INSERT INTO globals_new (key, id, value, created_at, updated_at, display_key)
            SELECT
              key,
              ${selectId} as id,
              value,
              ${selectCreated} as created_at,
              ${selectUpdated} as updated_at,
              ${selectDisplay} as display_key
            FROM globals
          `);
          await database.exec("DROP TABLE globals");
          await database.exec("ALTER TABLE globals_new RENAME TO globals");
          await database.exec("SELECT crsql_as_crr('globals')");
          await database.exec("COMMIT");
          return;
        } catch (err) {
          await database.exec("ROLLBACK");
          throw err;
        }
      }

      if (!names.has("id")) {
        await database.exec(
          "ALTER TABLE globals ADD COLUMN id TEXT NOT NULL DEFAULT ''",
        );
        await database.exec("UPDATE globals SET id = key WHERE id IS NULL");
      }
      if (!names.has("created_at")) {
        await database.exec(
          "ALTER TABLE globals ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'))",
        );
        await database.exec(
          "UPDATE globals SET created_at = datetime('now') WHERE created_at IS NULL",
        );
      }
      if (!names.has("updated_at")) {
        await database.exec(
          "ALTER TABLE globals ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
        );
        await database.exec(
          "UPDATE globals SET updated_at = datetime('now') WHERE updated_at IS NULL",
        );
      }
      if (!names.has("display_key")) {
        await database.exec(
          "ALTER TABLE globals ADD COLUMN display_key TEXT NOT NULL DEFAULT ''",
        );
        await database.exec(
          "UPDATE globals SET display_key = key WHERE display_key IS NULL",
        );
      }
      await database.exec("SELECT crsql_as_crr('globals')");
    } catch (err) {
      console.error("[syncStore] Failed to ensure globals schema", err);
    }
  }

  /**
   * CR-SQLite's generated update trigger for a table, or `undefined` when the
   * table is not a CRR on this connection.
   */
  async function crrUpdateTriggerSql(database, table) {
    const rows = await database.execO(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      [`${table}__crsql_utrig`],
    );
    return rows?.[0]?.sql;
  }

  /**
   * Adds the `pinned` document attribute to databases created before the Recent
   * Documents redesign.
   */
  async function ensureNotesSchema(database) {
    if (!database) throw new Error("Database scope is required for schema initialization.");
    try {
      const columns = await database.execO("PRAGMA table_info('notes')");
      if (!columns || columns.length === 0) return;

      const names = new Set(columns.map((column) => column.name));
      const triggerSql = await crrUpdateTriggerSql(database, "notes");
      const isCrr = Boolean(triggerSql);

      if (!names.has("pinned")) {
        if (isCrr) await database.exec("SELECT crsql_begin_alter('notes')");
        try {
          await database.exec(
            "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
          );
          await database.exec(
            "UPDATE notes SET pinned = 0 WHERE pinned IS NULL",
          );
        } finally {
          if (isCrr) await database.exec("SELECT crsql_commit_alter('notes')");
        }
        return;
      }

      if (isCrr && !triggerSql.includes("pinned")) {
        await database.exec("SELECT crsql_begin_alter('notes')");
        await database.exec("SELECT crsql_commit_alter('notes')");
      }
    } catch (err) {
      console.error("[syncStore] Failed to ensure notes schema", err);
    }
  }

  /**
   * Adds `size_bytes` and `sha256` to databases created before those columns
   * existed.
   *
   * `images` is a CRR, and CR-SQLite generates its insert/update/delete
   * triggers from the column list at registration time. A bare `ALTER TABLE`
   * leaves triggers bound to the old column count, so the next write fails with
   * `expected N values, got M` — and re-running `crsql_as_crr` does not rebuild
   * them, it reports success and leaves the stale triggers in place.
   * `crsql_begin_alter` / `crsql_commit_alter` is the supported way to change a
   * CRR's shape.
   */
  async function ensureImagesSchema(database) {
    if (!database) throw new Error("Database scope is required for schema initialization.");
    try {
      const columns = await database.execO("PRAGMA table_info('images')");
      if (!columns || columns.length === 0) {
        return;
      }

      const names = new Set((columns || []).map((c) => c.name));
      const triggerSql = await crrUpdateTriggerSql(database, "images");
      const isCrr = Boolean(triggerSql);
      const missing = ["size_bytes", "sha256"].filter((c) => !names.has(c));

      if (missing.length > 0) {
        if (isCrr) await database.exec("SELECT crsql_begin_alter('images')");
        try {
          if (!names.has("size_bytes")) {
            await database.exec(
              "ALTER TABLE images ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0",
            );
            await database.exec(
              "UPDATE images SET size_bytes = 0 WHERE size_bytes IS NULL",
            );
          }

          if (!names.has("sha256")) {
            await database.exec(
              "ALTER TABLE images ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''",
            );
            await database.exec(
              "UPDATE images SET sha256 = '' WHERE sha256 IS NULL",
            );
          }
        } finally {
          if (isCrr) await database.exec("SELECT crsql_commit_alter('images')");
        }

        if (!isCrr) await database.exec("SELECT crsql_as_crr('images')");
        return;
      }

      // Self-heal a database whose columns were added by the old bare-ALTER
      // migration, or by a run interrupted before the commit.
      if (isCrr && !["size_bytes", "sha256"].every((c) => triggerSql.includes(c))) {
        await database.exec("SELECT crsql_begin_alter('images')");
        await database.exec("SELECT crsql_commit_alter('images')");
        return;
      }

      if (!isCrr) await database.exec("SELECT crsql_as_crr('images')");
    } catch (err) {
      console.error("[syncStore] Failed to ensure images schema", err);
    }
  }

  async function ensureTemplatesSchema(database) {
    if (!database) throw new Error("Database scope is required for schema initialization.");
    try {
      const columns = await database.execO("PRAGMA table_info('templates')");
      const tableExists = columns && columns.length > 0;

      if (!tableExists) {
        await database.exec(`
          CREATE TABLE IF NOT EXISTS templates (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            title_pattern TEXT NOT NULL DEFAULT '',
            default_folder_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        await database.exec(
          "CREATE INDEX IF NOT EXISTS idx_templates_updated ON templates(updated_at DESC)",
        );
        await database.exec("SELECT crsql_as_crr('templates')");
        await seedDefaultTemplates(database);
        return;
      }

      // Add title_pattern column if missing (added in v1.1)
      const hasTitlePattern = columns.some((c) => c.name === "title_pattern");
      if (!hasTitlePattern) {
        await database.exec(
          "ALTER TABLE templates ADD COLUMN title_pattern TEXT NOT NULL DEFAULT ''",
        );
      }

      // Add default_folder_id column if missing (added in v1.1)
      const hasDefaultFolder = columns.some(
        (c) => c.name === "default_folder_id",
      );
      if (!hasDefaultFolder) {
        await database.exec(
          "ALTER TABLE templates ADD COLUMN default_folder_id TEXT",
        );
      }

      // Check if existing table has the old schema (NOT NULL columns without DEFAULTs)
      // CR-SQLite requires DEFAULTs on all NOT NULL columns
      const needsMigration = columns.some(
        (c) =>
          (c.name === "name" ||
            c.name === "created_at" ||
            c.name === "updated_at") &&
          c.notnull === 1 &&
          c.dflt_value === null,
      );

      if (needsMigration) {
        // Recreate table with proper DEFAULTs
        await database.exec(`
          ALTER TABLE templates RENAME TO templates_old;

          CREATE TABLE templates (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            title_pattern TEXT NOT NULL DEFAULT '',
            default_folder_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          INSERT INTO templates SELECT * FROM templates_old;
          CREATE INDEX IF NOT EXISTS idx_templates_updated ON templates(updated_at DESC);
          DROP TABLE templates_old;
        `);
      }

      const rows = await database.execO(
        "SELECT COUNT(*) AS cnt FROM templates",
      );
      if (rows[0]?.cnt === 0) {
        await seedDefaultTemplates(database);
      }

      await database.exec("SELECT crsql_as_crr('templates')");
    } catch (err) {
      console.error("[syncStore] Failed to ensure templates schema", err);
    }
  }

  async function seedDefaultTemplates(database) {
    const rows = await database.execO("SELECT COUNT(*) AS cnt FROM templates");
    if (rows[0]?.cnt > 0) return;

    const now = new Date().toISOString();
    const defaults = [
      {
        name: "Meeting Notes",
        titlePattern: "",
        defaultFolderId: null,
        content: `---
title: "{{input:Meeting Title}}"
date: "{{today}}"
attendees: "{{input:Attendees (comma-separated)}}"
tags:
  - "meeting"
  - "{{input:Project Tag}}"
---

# {{input:Meeting Title}}

**Date:** {{today}}
**Attendees:** {{input:Attendees (comma-separated)}}

## Agenda

1. {{input:Agenda Item 1}}
2. {{input:Agenda Item 2}}

## Notes

- {{input:Key discussion point}}

## Action Items

- [ ] {{input:Action item}} — Assigned to: {{input:Owner}}
`,
      },
      {
        name: "Project Brief",
        titlePattern: "",
        defaultFolderId: null,
        content: `---
title: "{{input:Project Name}} - Project Brief"
author: "{{input:Author}}"
date: "{{today}}"
status: "draft"
tags:
  - "project"
  - "{{input:Department}}"
---

# {{input:Project Name}}

**Objective:** {{input:Project Objective}}

## Scope

{{input:Describe the scope of the project}}

## Timeline

- Start: {{today}}
- Target: {{input:Target completion date}}

## Stakeholders

- {{input:Stakeholder name and role}}
`,
      },
      {
        name: "Journal Entry",
        titlePattern: "Journal Entry — {{today:dd-MM-yyyy}}",
        defaultFolderId: null,
        content: `---
title: "Journal Entry - {{today}}"
date: "{{today}}"
mood: "{{input:Mood}}"
tags:
  - "journal"
---

# Journal Entry — {{today}}

**Mood:** {{input:Mood}}

{{input:What happened today?}}
`,
      },
      {
        name: "Bug Report",
        titlePattern: "Bug Report: {{input:Bug Title}}",
        defaultFolderId: null,
        content: `---
title: "Bug: {{input:Bug Title}}"
date: "{{today}}"
severity: "{{input:Severity (low/medium/high/critical)}}"
tags:
  - "bug"
  - "{{input:Component}}"
---

# Bug Report: {{input:Bug Title}}

**Severity:** {{input:Severity (low/medium/high/critical)}}
**Component:** {{input:Component}}

## Steps to Reproduce

1. {{input:Step 1}}
2. {{input:Step 2}}
3. {{input:Step 3}}

## Expected Behavior

{{input:What should happen?}}

## Actual Behavior

{{input:What actually happens?}}

## Environment

- {{input:Browser/OS/Device details}}

## Additional Context

{{input:Any logs, screenshots, or notes}}
`,
      },
    ];

    for (const tpl of defaults) {
      await database.exec(
        "INSERT INTO templates (id, name, content, title_pattern, default_folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          uuidv4(),
          tpl.name,
          tpl.content,
          tpl.titlePattern || "",
          tpl.defaultFolderId || null,
          now,
          now,
        ],
      );
    }
  }

  function setupOnlineOfflineListeners() {
    const handleOnline = async () => {
      console.info("[Sync] Network connection restored");
      isOnline.value = true;

      const auth = useAuthStore();
      if (auth.isAuthenticated && syncEnabled.value) {
        // Reset auth warning flag when coming online
        hasShownAuthWarning.value = false;

        // Show toast
        const { useUiStore } = await import("./uiStore");
        const uiStore = useUiStore();
        uiStore.addToast("Back online! Syncing your documents...", "success", 3000);

        // Reconnect websocket and sync
        connectWebSocket();
        sync();
      } else if (auth.isAuthenticated && !syncEnabled.value) {
        // User is authenticated but sync was disabled while offline
        const { useUiStore } = await import("./uiStore");
        const uiStore = useUiStore();
        uiStore.addToast(
          "Back online! Enable sync to sync your documents.",
          "info",
          5000,
        );
      }
    };

    const handleOffline = async () => {
      console.info("[Sync] Network connection lost");
      isOnline.value = false;

      const { useUiStore } = await import("./uiStore");
      const uiStore = useUiStore();
      uiStore.addToast(
        "You're offline. Changes will sync when you reconnect.",
        "warning",
        5000,
      );

      // Disconnect websocket when offline (but don't disable sync)
      // This way sync state is preserved for when we come back online
      disconnectWebSocket();
    };

    // Remove existing listeners if any
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);

    // Add new listeners
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
  }

  async function resetDatabase() {
    disconnectWebSocket();
    shouldReconnect = false;
    hasShownAuthWarning.value = false;
    for (const entry of databases.value.values()) {
      try {
        await entry.db?.close();
      } catch {
        // The handle is being discarded whether already closed or mid-teardown.
      }
    }
    databases.value.clear();
    isInitialized.value = false;
    membershipVersion.value = 0;
    membershipRefreshRequested = false;
    sharedSpacesAvailable.value = false;
    bootstrapState.value = { status: "idle", currentDbKey: null, completed: 0, total: 0, error: null };
  }

  function hexToUint8Array(hex) {
    if (!hex || hex.length % 2 !== 0) return new Uint8Array();
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }

  async function applyRemoteRows(database, remoteChanges) {
    const insertSQL = `INSERT INTO crsql_changes ("table", pk, cid, val, col_version, db_version, site_id, seq, cl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    for (const ch of remoteChanges) {
      await database.exec(insertSQL, [
        ch.table,
        hexToUint8Array(ch.pk),
        ch.cid,
        ch.val,
        ch.col_version,
        ch.db_version,
        hexToUint8Array(ch.site_id),
        ch.seq,
        ch.cl,
      ]);
    }
  }

  async function upsertMergeBase(database, noteId, content) {
    await database.exec(
      `INSERT INTO note_sync_base (note_id, content, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(note_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      [noteId, content ?? "", new Date().toISOString()],
    );
  }

  async function recordConflict(database, noteId, base, mine, theirs, conflicts) {
    const now = new Date().toISOString();
    await database.exec(
      `INSERT INTO note_conflicts
         (note_id, base_content, mine_content, theirs_content, conflict_hunks, created_at, updated_at, merge_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(note_id) DO UPDATE SET
         base_content = excluded.base_content,
         mine_content = excluded.mine_content,
         theirs_content = excluded.theirs_content,
         conflict_hunks = excluded.conflict_hunks,
         updated_at = excluded.updated_at,
         merge_attempts = note_conflicts.merge_attempts + 1`,
      [noteId, base ?? "", mine ?? "", theirs ?? "", serializeConflictHunks(conflicts), now, now],
    );
  }

  async function clearConflict(database, noteId) {
    await database.exec("DELETE FROM note_conflicts WHERE note_id = ?", [noteId]);
  }

  /**
   * Applies remote CR-SQLite changes inside one transaction, capturing each
   * affected document's `mine` before apply and `theirs` after, then resolving
   * content merges per COLLAB-02 §5.3.
   *
   * @returns {Promise<boolean>} true when a local content write needs a follow-up sync
   */
  async function applyRemoteChanges(entry, remoteChanges) {
    let didLocalWrite = false;
    const database = entry.db;

    const noteIds = new Set();
    for (const ch of remoteChanges) {
      if (ch.table === "notes" && ch.cid === "content") {
        const noteId = parsePkId(ch.pk);
        if (noteId) noteIds.add(noteId);
      }
    }

    const idList = [...noteIds];

    entry.isApplyingRemote = true;
    try {
      if (idList.length === 0) {
        await database.exec("BEGIN");
        try {
          await applyRemoteRows(database, remoteChanges);
          await database.exec("COMMIT");
        } catch (e) {
          await database.exec("ROLLBACK");
          throw e;
        }
        return didLocalWrite;
      }

      const placeholders = idList.map(() => "?").join(",");

      await database.exec("BEGIN");
      try {
        const mineMap = new Map();
        const mineRows = await database.execO(
          `SELECT id, COALESCE(content, '') AS content FROM notes WHERE id IN (${placeholders})`,
          idList,
        );
        for (const row of mineRows) mineMap.set(row.id, row.content);

        await applyRemoteRows(database, remoteChanges);

        const theirsMap = new Map();
        const theirsRows = await database.execO(
          `SELECT id, COALESCE(content, '') AS content FROM notes WHERE id IN (${placeholders})`,
          idList,
        );
        for (const row of theirsRows) theirsMap.set(row.id, row.content);

        const draftStore = useDraftStore();

        for (const noteId of idList) {
          const dbMine = mineMap.get(noteId) ?? "";
          const theirs = theirsMap.get(noteId) ?? "";
          if (collabRemoteGuard?.(entry.dbKey, noteId, theirs)) {
            await upsertMergeBase(database, noteId, theirs);
            continue;
          }
          const draft = draftStore.getDraft(noteId);
          const mine = draft !== undefined ? draft : dbMine;

          const baseRows = await database.execO(
            "SELECT content, writeback_count, writeback_window_started_at FROM note_sync_base WHERE note_id = ?",
            [noteId],
          );
          const hasBase = baseRows.length > 0;
          const base = hasBase ? baseRows[0].content : undefined;

          const resolved = resolveSyncMerge({
            hasBase,
            hasMine: mineMap.has(noteId) || draft !== undefined,
            base,
            mine,
            theirs,
            capabilityEnabled: contentMergeWriteback.value,
          });

          if (resolved.action === "write-merge") {
            const guard = evaluateWritebackGuard({
              writebackCount: hasBase ? baseRows[0].writeback_count : 0,
              windowStartedAt: hasBase ? baseRows[0].writeback_window_started_at : null,
            });

            if (!guard.allowed) {
              console.info(
                `[Sync] Suppressing merge write-back for ${noteId} (oscillation guard).`,
              );
              await recordConflict(database, noteId, base, mine, theirs, resolved.conflicts);
              continue;
            }

            await database.exec(
              "UPDATE notes SET content = ?, updated_at = ? WHERE id = ?",
              [resolved.content, new Date().toISOString(), noteId],
            );
            await database.exec(
              `INSERT INTO note_sync_base (note_id, content, writeback_count, writeback_window_started_at, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(note_id) DO UPDATE SET
                 content = excluded.content,
                 writeback_count = excluded.writeback_count,
                 writeback_window_started_at = excluded.writeback_window_started_at,
                 updated_at = excluded.updated_at`,
              [noteId, resolved.content, guard.writebackCount, guard.windowStartedAt, new Date().toISOString()],
            );
            await clearConflict(database, noteId);
            didLocalWrite = true;
          } else if (resolved.action === "restore-mine") {
            await database.exec(
              "UPDATE notes SET content = ?, updated_at = ? WHERE id = ?",
              [resolved.content, new Date().toISOString(), noteId],
            );
            await upsertMergeBase(database, noteId, resolved.content);
            await clearConflict(database, noteId);
            didLocalWrite = true;
          } else if (resolved.action === "adopt-theirs" || resolved.action === "record-base") {
            await upsertMergeBase(database, noteId, resolved.content);
            await clearConflict(database, noteId);
          } else {
            await recordConflict(database, noteId, base, mine, theirs, resolved.conflicts);
          }
        }

        await database.exec("COMMIT");
      } catch (e) {
        await database.exec("ROLLBACK");
        throw e;
      }
    } finally {
      entry.isApplyingRemote = false;
    }

    return didLocalWrite;
  }

  async function seedMissingMergeBases(database) {
    await database.exec(
      `INSERT OR IGNORE INTO note_sync_base (note_id, content, updated_at)
       SELECT id, COALESCE(content, ''), datetime('now') FROM notes`,
    );
  }

  async function fetchMembershipPages() {
    const auth = useAuthStore();
    const spaces = [];
    let cursor = null;
    let version = null;
    let minimumSchema = 0;
    do {
      const suffix = cursor ? `?limit=25&cursor=${encodeURIComponent(cursor)}` : "?limit=25";
      const response = await fetch(`${API_URL}/spaces${suffix}`, {
        headers: { Authorization: `Bearer ${auth.token || ""}` },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Space discovery failed: ${response.status}`);
      const page = await response.json();
      spaces.push(...(Array.isArray(page.spaces) ? page.spaces : []));
      const pageVersion = Number(page.membershipVersion) || 0;
      if (version === null) version = pageVersion;
      else if (pageVersion !== version) {
        throw new Error("Space membership changed during paginated discovery.");
      }
      minimumSchema = Math.max(minimumSchema, Number(page.minimum_client_schema) || 0);
      cursor = page.nextCursor || null;
    } while (cursor);
    return { spaces, membershipVersion: version ?? 0, minimumSchema };
  }

  async function removeDatabase(dbKey, { notifyServer = true } = {}) {
    const entry = databases.value.get(dbKey);
    if (!entry || dbKey === personalDbKey.value) return;
    entry.syncPending = false;
    entry.isSyncing = false;
    const { useStructureStore } = await import("./structureStore");
    const { useDraftStore } = await import("./draftStore");
    const { useHistoryStore } = await import("./historyStore");
    const { useConflictStore } = await import("./conflictStore");
    const affectedNoteIds = useStructureStore().clearDatabaseScope(dbKey);
    const drafts = useDraftStore();
    const history = useHistoryStore();
    for (const noteId of affectedNoteIds) {
      drafts.clearDraft(noteId);
      drafts.clearBase(noteId);
      history.clear(noteId);
    }
    useConflictStore().clearDatabase(dbKey);
    if (notifyServer && ws.value?.readyState === WebSocket.OPEN) {
      ws.value.send(JSON.stringify({
        v: 1,
        type: "unsubscribe",
        requestId: uuidv4(),
        payload: { dbKeys: [dbKey] },
      }));
    }
    try {
      await entry.db?.close();
    } catch {
      // Revocation removes the handle from the active registry even if close races.
    }
    databases.value.delete(dbKey);
  }

  async function bootstrapSpaces(spaces) {
    const pending = (spaces || []).filter((space) => {
      const dbKey = createDatabaseKey("space", space.spaceId);
      return !databases.value.get(dbKey)?.db;
    });
    bootstrapState.value = {
      status: pending.length ? "loading" : "ready",
      currentDbKey: null,
      completed: 0,
      total: pending.length,
      error: null,
    };

    for (const space of pending) {
      const dbKey = createDatabaseKey("space", space.spaceId);
      bootstrapState.value.currentDbKey = dbKey;
      try {
        if (navigator.storage?.estimate) await navigator.storage.estimate();
        const entry = await openDatabaseEntry({
          dbKey,
          name: space.name,
          role: space.role,
          members: space.members || [],
        });
        await syncDatabase(entry);
        subscribeInitializedDatabases();
      } catch (error) {
        const existing = databases.value.get(dbKey);
        if (existing?.db) {
          try { await existing.db.close(); } catch { /* discard below */ }
        }
        databases.value.set(dbKey, {
          dbKey,
          kind: "space",
          db: null,
          siteId: null,
          clock: getClock(dbKey),
          name: space.name,
          role: space.role,
          members: space.members || [],
          syncPending: false,
          status: isStorageQuotaError(error) ? "quota-error" : "bootstrap-error",
          error: isStorageQuotaError(error)
            ? "This space could not be stored on this device. Free storage and retry."
            : "This space could not be initialized. Retry when the connection is stable.",
        });
      } finally {
        bootstrapState.value.completed++;
      }
    }
    const failed = [...databases.value.values()].find(
      (entry) => entry.kind === "space" && !entry.db,
    );
    bootstrapState.value = failed
      ? {
          ...bootstrapState.value,
          status: failed.status === "quota-error" ? "quota-error" : "error",
          currentDbKey: failed.dbKey,
          error: failed.error,
        }
      : { ...bootstrapState.value, status: "ready", currentDbKey: null, error: null };
  }

  function reportMembershipRefreshFailure(error) {
    console.warn("[syncStore] Shared-space discovery failed", error);
    bootstrapState.value = {
      ...bootstrapState.value,
      status: "error",
      currentDbKey: null,
      error: "Shared spaces could not be loaded. Personal Documents remain available.",
    };
  }

  async function refreshMembership({ bootstrap = false } = {}) {
    if (!isInitialized.value || !personalDbKey.value) return;
    if (membershipRefreshPromise) return membershipRefreshPromise;
    membershipRefreshPromise = (async () => {
      const snapshot = await fetchMembershipPages();
      if (!snapshot) {
        sharedSpacesAvailable.value = false;
        return;
      }
      sharedSpacesAvailable.value = true;
      if (snapshot.minimumSchema > 1) {
        bootstrapState.value = {
          status: "upgrade-required",
          currentDbKey: null,
          completed: 0,
          total: snapshot.spaces.length,
          error: "Update Panino before opening shared spaces.",
        };
        return;
      }

      const { revoked } = reconcileMembershipKeys(
        databases.value.keys(),
        personalDbKey.value,
        snapshot.spaces,
      );
      for (const dbKey of revoked) await removeDatabase(dbKey);
      for (const space of snapshot.spaces) {
        const entry = databases.value.get(createDatabaseKey("space", space.spaceId));
        if (entry) Object.assign(entry, {
          name: space.name,
          role: space.role,
          members: space.members || [],
        });
      }
      membershipVersion.value = snapshot.membershipVersion;
      await bootstrapSpaces(snapshot.spaces);
      if (!bootstrap) await useDocStore().refreshData();
    })().finally(() => {
      membershipRefreshPromise = null;
      if (membershipRefreshRequested) {
        membershipRefreshRequested = false;
        queueMicrotask(() => {
          void refreshMembership().catch(reportMembershipRefreshFailure);
        });
      }
    });
    return membershipRefreshPromise;
  }

  async function requestMembershipRefresh() {
    if (membershipRefreshPromise) {
      membershipRefreshRequested = true;
      return;
    }
    await refreshMembership();
  }

  async function retryBootstrap(dbKey) {
    parseDatabaseKey(dbKey);
    const failed = databases.value.get(dbKey);
    if (!failed || failed.kind !== "space") return;
    if (failed.db) {
      failed.status = "ready";
      failed.error = null;
      await sync(dbKey);
      await useDocStore().refreshData();
      return;
    }
    databases.value.delete(dbKey);
    await bootstrapSpaces([{
      spaceId: parseDatabaseKey(dbKey).id,
      name: failed.name,
      role: failed.role,
      members: failed.members,
    }]);
    await useDocStore().refreshData();
  }

  async function syncDatabase(entry, { allowAuthRetry = true } = {}) {
    const auth = useAuthStore();
    if (!entry?.db) return false;
    if (entry.isSyncing) {
      entry.syncPending = true;
      return false;
    }
    entry.isSyncing = true;
    const myClock = entry.clock;
    try {
      const localChanges = await entry.db.execO(
        `SELECT "table", pk, cid, val, col_version, db_version, lower(hex(site_id)) AS site_id, seq, cl FROM crsql_changes WHERE db_version > ? ORDER BY db_version ASC`,
        [myClock],
      );
      const target = parseDatabaseKey(entry.dbKey);
      const outgoingChanges = target.kind === "space"
        ? projectSpaceOutgoingChanges(localChanges)
        : localChanges;
      const body = {
        since: myClock,
        siteId: entry.siteId,
        changes: outgoingChanges,
      };
      if (target.kind === "space") body.space = target.id;

      const response = await fetch(`${API_URL}/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.token || ""}`,
        },
        body: JSON.stringify(body),
      });
      if ((response.status === 401 || response.status === 403) && allowAuthRetry) {
        if (await auth.refreshToken()) {
          entry.isSyncing = false;
          return syncDatabase(entry, { allowAuthRetry: false });
        }
      }
      if (response.status === 404 && target.kind === "space") {
        await requestMembershipRefresh();
      }
      if (!response.ok) {
        const error = new Error(`Sync failed for ${entry.dbKey}: ${response.status}`);
        error.status = response.status;
        throw error;
      }

      const data = await response.json();
      contentMergeWriteback.value = data.contentMergeWriteback === true;
      if (data.changes?.length) {
        const didLocalWrite = await applyRemoteChanges(entry, data.changes);
        if (didLocalWrite) entry.syncPending = true;
      }
      await seedMissingMergeBases(entry.db);

      // The clock is persisted only after every remote row and merge base has
      // committed successfully.
      if (
        target.kind === "space" &&
        Number(data.membershipVersion) !== membershipVersion.value
      ) {
        await requestMembershipRefresh();
      }
      setClock(entry.dbKey, data.clock ?? myClock);
      entry.status = "ready";
      entry.error = null;
      return true;
    } finally {
      entry.isSyncing = false;
    }
  }

  async function sync(dbKey = null) {
    const auth = useAuthStore();
    if (!syncEnabled.value || !isInitialized.value || !auth.isAuthenticated) return;
    if (isSyncing.value) {
      const requested = dbKey ? databases.value.get(dbKey) : null;
      if (requested) requested.syncPending = true;
      else for (const entry of databases.value.values()) entry.syncPending = true;
      return;
    }

    if (!isOnline.value) {
      console.info("[Sync] Skipping sync - offline");
      return;
    }

    isSyncing.value = true;
    try {
      const entries = dbKey
        ? [requireEntry(dbKey)]
        : [...databases.value.values()].filter((entry) => entry.db);
      const results = await runSequentially(entries, async (entry) => {
        try {
          return await syncDatabase(entry);
        } catch (error) {
          entry.status = isStorageQuotaError(error) ? "quota-error" : "sync-error";
          entry.error = isStorageQuotaError(error)
            ? "This database ran out of local storage. Free storage and retry."
            : "Sync failed. Local changes are safe and will retry.";
          console.error(`[syncStore] sync error for ${entry.dbKey}`, error);
          return false;
        }
      });
      const docStore = useDocStore();
      await docStore.refreshData();
      if (results.some((result) => result.status === "fulfilled" && result.value)) {
        await useGlobalVariablesStore().loadGlobals(
          docStore.selectedDbKey || personalDbKey.value,
        );
      }
    } finally {
      isSyncing.value = false;
      if ([...databases.value.values()].some((entry) => entry.syncPending)) {
        for (const entry of databases.value.values()) entry.syncPending = false;
        queueMicrotask(() => void sync());
      }
    }
  }

  function subscribeInitializedDatabases() {
    if (ws.value?.readyState !== WebSocket.OPEN) return;
    const subscriptions = [...databases.value.values()]
      .filter((entry) => entry.db && entry.siteId)
      .map(({ dbKey, siteId }) => ({ dbKey, siteId }));
    if (!subscriptions.length) return;
    ws.value.send(JSON.stringify({
      v: 1,
      type: "subscribe",
      requestId: uuidv4(),
      payload: { databases: subscriptions },
    }));
  }

  function connectWebSocket() {
    if (ws.value || !syncEnabled.value) return;
    const auth = useAuthStore();
    const personalEntry = databases.value.get(personalDbKey.value);
    if (!auth.token || !personalEntry?.siteId) return;

    shouldReconnect = true;
    console.info("[Sync] Connecting WebSocket...");
    ws.value = new WebSocket(`${WS_URL}?token=${auth.token}&siteId=${personalEntry.siteId}`);

    ws.value.onopen = () => {
      console.info("[Sync] WebSocket connected.");
      subscribeInitializedDatabases();
      notifyWebSocketListeners({ type: "socket:open" });
    };
    ws.value.onclose = () => {
      ws.value = null;
      console.info("[Sync] WebSocket disconnected.");
      notifyWebSocketListeners({ type: "socket:close" });
      if (shouldReconnect && isOnline.value && syncEnabled.value) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWebSocket, 1000);
      }
    };
    ws.value.onerror = (err) => console.error("[Sync] WebSocket error:", err);
    ws.value.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      notifyWebSocketListeners(msg);
      if (msg.type === "sync") {
        const target = msg.payload?.dbKey || personalDbKey.value;
        if (databases.value.has(target)) void sync(target);
      } else if (msg.type === "subscription:revoked" && msg.payload?.dbKey) {
        await removeDatabase(msg.payload.dbKey, { notifyServer: false });
        await requestMembershipRefresh();
      } else if (
        msg.type === "membership:changed" &&
        Number.isFinite(Number(msg.payload?.membershipVersion)) &&
        Number(msg.payload.membershipVersion) !== membershipVersion.value
      ) {
        try {
          await requestMembershipRefresh();
        } catch (error) {
          reportMembershipRefreshFailure(error);
        }
      } else if (
        msg.ok === true &&
        msg.type === "subscribe" &&
        Number.isFinite(Number(msg.payload?.membershipVersion)) &&
        Number(msg.payload.membershipVersion) !== membershipVersion.value
      ) {
        try {
          await requestMembershipRefresh();
        } catch (error) {
          reportMembershipRefreshFailure(error);
        }
      } else if (
        msg.ok === false &&
        msg.type === "subscribe" &&
        msg.error?.code === "SPACE_NOT_FOUND"
      ) {
        try {
          await requestMembershipRefresh();
        } catch (error) {
          reportMembershipRefreshFailure(error);
        }
      }
    };
  }

  function disconnectWebSocket() {
    shouldReconnect = false;
    clearTimeout(reconnectTimer);
    if (ws.value) {
      ws.value.close();
      ws.value = null;
    }
  }

  function setSyncEnabled(v) {
    const auth = useAuthStore();

    // Prevent enabling sync if offline or not authenticated
    if (v && !isOnline.value) {
      console.warn("[Sync] Cannot enable sync while offline");
      return false;
    }

    if (v && !auth.isAuthenticated) {
      console.warn("[Sync] Cannot enable sync without authentication");
      return false;
    }

    syncEnabled.value = v;

    if (v) {
      shouldReconnect = true;
      hasShownAuthWarning.value = false; // Reset warning flag when re-enabling sync
      console.info("[Sync] Sync enabled, connecting...");
      connectWebSocket();
      sync();
    } else {
      console.info("[Sync] Sync disabled, disconnecting...");
      disconnectWebSocket();
    }

    return true;
  }

  return {
    databases,
    personalDbKey,
    membershipVersion,
    sharedSpacesAvailable,
    bootstrapState,
    isInitialized,
    syncEnabled,
    isSyncing,
    isOnline,
    contentMergeWriteback,
    repository,
    personalRepository,
    execute,
    exec,
    initializeDB,
    resetDatabase,
    sync,
    refreshMembership,
    requestMembershipRefresh,
    retryBootstrap,
    removeDatabase,
    subscribeInitializedDatabases,
    setSyncEnabled,
    ensureGlobalsSchema,
    ensureNotesSchema,
    ensureImagesSchema,
    ensureTemplatesSchema,
    connectWebSocket,
    disconnectWebSocket,
    addWebSocketListener,
    sendWebSocketMessage,
    setCollabRemoteGuard,
  };
});
