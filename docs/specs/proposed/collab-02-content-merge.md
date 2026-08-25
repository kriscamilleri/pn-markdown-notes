# COLLAB-02 — Content Merge

> Three-way merge document bodies at sync boundaries instead of losing one side.
> Status: proposed
> Created: 2026-08-16
> Last updated: 2026-08-16 (final review)
> Part of [COLLAB-00](collab-00-overview.md) · Depends on [COLLAB-01](collab-01-editor-conflict-safety.md)

---

## 1) Summary

[COLLAB-01](collab-01-editor-conflict-safety.md) stops the editor destroying remote edits, but it
only handles the document that happens to be **open**, and it resolves by asking the user to pick a
side. This spec handles every document and merges automatically when the edits do not overlap —
the common case for two people working on different sections.

It requires no CRR schema change and no backend runtime change. It does establish the shared merge
package and frontend build wiring that COLLAB-05 later consumes from the backend.

---

## 2) The gap COLLAB-01 leaves

For a document that is not open in the editor, CR-SQLite has already resolved LWW by the time any
client code runs. Sequence, when a user edits document X offline:

1. `updateFileContent` writes X locally; CR-SQLite records a `content` column change.
2. On reconnect, `sync()` pushes that change and pulls remote changes
   ([syncStore.js:675-800](../../../frontend/src/store/syncStore.js#L675-L800)).
3. If the remote `content` change wins on `(col_version, site_id)`, applying it **overwrites the
   local column**. The user's offline work is gone from the local database before any UI runs.

It survives in backend `note_revisions`, but the user is never told, and for a document they are
not looking at they will likely never find out.

The fix is to capture the local value *before* applying remote changes, and merge afterwards.

---

## 3) Goals

1. Non-overlapping concurrent edits to one document merge automatically, on every device.
2. Overlapping edits produce a visible, resolvable conflict — never a silent loss.
3. Works for documents that are not open in the editor.
4. Works offline-first: the merge happens on the client, at sync time, with no server involvement.

## Non-goals

- No character-level realtime convergence. That is [COLLAB-05](collab-05-live-sessions.md).
- No merging of `title`, `folder_id`, or `pinned`. Last-writer-wins is the correct semantic for
  those fields and they stay as they are.
- No server-side merge. The backend continues to merge CRR rows and nothing else.

---

## 4) The base table

Merging needs a **base**: the content both sides last agreed on. `draftStore`'s in-memory base from
COLLAB-01 is not enough, because an offline edit may span an app reload.

Add a **local, non-CRR** table to the frontend database only:

```sql
CREATE TABLE IF NOT EXISTS note_sync_base (
  note_id                     TEXT PRIMARY KEY NOT NULL,
  content                     TEXT NOT NULL DEFAULT '',
  writeback_count             INTEGER NOT NULL DEFAULT 0,
  writeback_window_started_at TEXT,
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Rules, all of which matter:

- Declare it in `DB_SCHEMA` ([syncStore.js:19-50](../../../frontend/src/store/syncStore.js#L19-L50)).
- **Do not** call `crsql_as_crr` on it. **Do not** add it to `CRR_TABLES` in
  [db.js:118-126](../../../backend/api-service/db.js#L118-L126).
- **Do not** add it to the backend `BASE_SCHEMA`. This is a deliberate, documented asymmetry: the
  schema-alignment rule in [crsqlite-sync.md](../../architecture/crsqlite-sync.md) governs CRR
  tables, and this is client-local state, like `crsqlite_clock` in `localStorage`.
- **No foreign key to `notes`.** The rule for local children of a CRR parent is
  `ON DELETE CASCADE` — but adding an FK to a CRR parent is the exact shape that caused the
  2026-06-29 `constraint failed` incident, and this table sits directly in the sync path. Prune
  orphans opportunistically instead (§6.4). The cost of a stale row is a few KB; the cost of an FK
  aborting a merge transaction is an outage.
- Add `note_sync_base` and `note_conflicts` to an explicit `LOCAL_ONLY_TABLES` constant in
  [importExportStore.js](../../../frontend/src/store/importExportStore.js). Every JSON, ZIP,
  StackEdit and SQLite export excludes those tables; SQLite export creates a sanitized copy rather
  than exposing the live database file. Every importer ignores/rejects those names before writing.
  Round-trip tests prove neither table leaves the device or overwrites another device's recovery
  state. This list is exact, not a prefix convention that might silently hide future user data.

Base is written when, and only when, this client and the server agree on a value: after a
successful sync, and after adopting or committing content.

### 4.1 Upgrade safety

An absent base is **not** permission to discard local content. The release has two stages:

1. Ship the table and populate bases after successful ordinary syncs while the server capability
   `contentMergeWriteback` is false.
2. Enable merging only after telemetry confirms the migration has stabilized. If a remote content
   row reaches a document without a base and the pre-apply local value differs from the post-apply
   value, record an unresolved conflict containing both values. If they are equal, record the value
   as its base.

This means an upgraded offline client may need a one-time decision, but it never silently loses
work. New documents seed their base atomically with creation.

The server environment flag and fail-closed capability behavior are defined in
[COLLAB-00 §4](collab-00-overview.md). The client decides for each sync from that successful
response; a stale cached capability or local setting never authorizes write-back. While disabled,
classification and loss prevention still run: a divergent `mine` is preserved in
`note_conflicts`, even when the shared merge function reports a clean result, but no automatic
content write occurs. Enabling the capability affects automation, never whether a displaced body is
recoverable.

---

## 5) Merge algorithm

### 5.1 Library

`diff` v8 is **already a frontend dependency** and is used for revision diffs
([RevisionPanel.vue:94](../../../frontend/src/components/RevisionPanel.vue#L94)) — but v8 **removed**
the `merge` / `diff3Merge` exports that v5–v7 carried. The installed build exports only
`diffLines`, `structuredPatch`, `createPatch`, `applyPatch`, `parsePatch`, `reversePatch` and
friends. Verify before assuming otherwise:

```bash
node -e "console.log(Object.keys(require('./frontend/node_modules/diff/libcjs/index.js')).join(' '))"
```

Two options:

| Approach | Verdict |
|---|---|
| `createPatch(base → mine)` then `applyPatch(theirs, patch)` using the existing dep | **Rejected.** `applyPatch` is all-or-nothing: one overlapping paragraph fails the whole merge, so every conflict degrades to a full-document prompt. |
| Add `node-diff3` (~4KB, zero dependencies, MIT) | **Recommended.** Gives per-hunk results, so non-overlapping hunks merge and only the overlapping region is reported as a conflict. |

Create the repository-local `@panino/content-merge` package exactly as defined in
[COLLAB-00 §4](collab-00-overview.md). Its `shared/package.json` owns `node-diff3`; application
packages must not depend on `node-diff3` or call it directly.

### 5.2 Granularity

Merge on **lines**, not characters. Markdown is line-oriented, paragraphs are the natural unit of
concurrent authorship, and line-level conflicts are legible to a human in a way character-level
ones are not.

### 5.3 Placement in `sync()`

Inside `syncStore.sync()`, extend the existing remote-change application transaction
([syncStore.js:753-793](../../../frontend/src/store/syncStore.js#L753-L793)):

1. Set an `isApplyingRemote` guard before `BEGIN`. While set, `db.onUpdate` records that a follow-up
   may be needed but never invokes or debounces `sync()`.
2. **Before applying, inside the transaction.** Scan `remoteChanges` for rows with
   `table === 'notes'` and
   `cid === 'content'`; collect their note ids. Parsing the packed `pk` client-side mirrors
   `parsePkId` in [sync.js:90-121](../../../backend/api-service/sync.js#L90-L121) — extract a
   shared helper rather than writing a second parser.
3. `SELECT id, content FROM notes WHERE id IN (…)` → the `mine` map.
4. Apply the remote `crsql_changes` rows.
5. `SELECT id, content FROM notes WHERE id IN (…)` → the `theirs` map.
6. For each id, resolve per the table below. Merge write-backs use a parameterized `UPDATE` on this
   transaction's database context; do not call a helper that starts another transaction.
7. Update `note_sync_base` and `note_conflicts`, then `COMMIT`. Any parsing, merge, base or conflict
   persistence failure rolls back the remote application too; no partially-classified remote body is
   exposed.
8. After commit, apply guarded editor/draft updates for the open document. Do not mutate the
   textarea before commit succeeds.
9. Clear `isApplyingRemote` in `finally`. If step 6 wrote a merge result, set
   `syncPending = true`. After the current sync releases
   `isSyncing`, run exactly one queued follow-up sync. `onUpdate` alone is insufficient because it
   currently fires while a sync is in progress and its call is ignored.

| Case | Action |
|---|---|
| No base row, `mine === theirs` | Record the value as base. |
| No base row, `mine !== theirs` | Keep `theirs` in the database and create an unresolved conflict containing both values. |
| `mine === base` | Nothing local was pending. Accept `theirs`, update base. |
| `theirs === base` | Remote changed nothing meaningful. Restore `mine` with a normal local write and queue one follow-up sync. |
| `mine !== base`, `theirs !== base`, merge clean, capability enabled | Write merged text in the current transaction. Update base to merged. |
| `mine !== base`, `theirs !== base`, capability disabled | Keep `theirs`; preserve `mine`, `theirs` and the clean candidate/conflict hunks for manual resolution. |
| Merge has conflicts | Keep `theirs` in the database. Surface a conflict (§6). Do **not** write until resolved. |

Step 6's write-back creates an ordinary local change, so the queued follow-up sync replicates the
merged text to every other replica through the normal path. No new wire format.

### 5.4 Open documents

If the merged document is currently open **and dirty**, `mine` is the editor's draft
(`draftStore.getDraft`), not the database value — the draft may not have been flushed by the 500ms
debounce. Persist the chosen/merged result in the extended transaction, then route that committed
value through the editor (`setValue` + draft/base update) under COLLAB-01's programmatic-adoption
guard, including cursor preservation. This avoids both writing behind the editor and leaving the
database behind the session.

---

## 6) Conflicts

### 6.1 Presentation

Do **not** write conflict markers into the document body. Markdown has no conflict syntax, the
markers would render as garbage in preview and PDF, and they would replicate to everyone.

Instead: the database keeps `theirs`, and the unresolved local version is held in a client-local,
non-CRR `note_conflicts` table:

```sql
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
```

It has no foreign key and is excluded from import/export. Applying a resolution writes a normal
document change, updates the base only after that write succeeds, and deletes the conflict record.
The record is local recovery state, not a shared resolution workflow; another replica may present
its own conflict and a later normal sync resolves between the chosen bodies.

### 6.2 UI

- Open document → COLLAB-01's banner, with the wording adjusted to say some changes merged
  automatically and *n* regions need a decision.
- Not-open documents → one toast summarising the count, plus a persistent affordance in the
  document list (a small marker on `RecentDocumentRow` / `TreeItem`) so it is not lost when the
  toast expires.
- Resolution UI is the `diffLines` renderer extracted in COLLAB-01, showing conflicting hunks with
  **Keep mine** / **Use theirs** per hunk, and one **Apply** action.

### 6.3 Convergence caveat

If two replicas diverge simultaneously, each may produce its own merge result and then merge the
other's. `diff3` is not confluent. Automatic write-back is therefore constrained as follows:

- Only the replica whose local value was overwritten writes back a merge; a replica whose value
  won does nothing.
- The write-back is idempotent once both sides hold the same text.
- Cap it: `note_sync_base.writeback_count` and `writeback_window_started_at` form a persisted rolling
  guard. The first write-back starts the window; the fourth attempted write-back before 60 seconds
  have elapsed is suppressed and becomes a conflict. If 60 seconds elapse before the next attempt,
  reset the count/window and allow it. Applying a manual resolution also resets both fields. The
  winning manual resolution is an ordinary content write; every replica then adopts it through
  normal LWW sync. Log the cap event with document id hash and replica id hash.

### 6.4 Pruning

On each `loadRootItems`, delete `note_sync_base` and `note_conflicts` rows whose `note_id` has no
matching row in `notes`. A remote deletion concurrent with content changes always wins as a
deletion; preserve the pre-delete local body in a conflict record until the user dismisses or
copies it, then prune. This avoids the FK discussed in §4.

### 6.5 Normalization and budgets

Use `normalizeContent` from `@panino/content-merge`, including for equality checks; its exact
normalization and SHA-256 hashing contract is defined in [COLLAB-00 §4](collab-00-overview.md).
A merge may process at most 1 MiB per document and 50
documents per sync turn; larger documents or excess documents become visible conflicts and resume
on the next turn. Yield between documents. A PK that cannot be parsed never falls back silently:
if the pre/post values differ, create a conflict using the raw change metadata; otherwise log and
skip merge handling.

---

## 7) Files touched

| File | Change |
|---|---|
| `frontend/src/store/syncStore.js` | `DB_SCHEMA` additions, pre/post capture around remote application, merge dispatch |
| `frontend/src/store/docStore.js` | Merge write-back path; conflict state |
| `frontend/src/store/draftStore.js` | Base becomes durable-backed; conflict records |
| `shared/contentMerge.js`, `shared/package.json` | **New.** Canonical `@panino/content-merge` package and dependency |
| `shared/tests/contentMerge.test.js` | **New.** Cross-runtime vectors and merge tests |
| `frontend/src/utils/crsqlitePk.js` | **New.** Shared `pk` parsing, mirroring `parsePkId` |
| `frontend/src/components/Editor.vue` | Conflict banner wording; hunk resolution entry point |
| `frontend/src/components/TreeItem.vue`, `RecentDocumentRow.vue` | Unresolved-conflict marker |
| `frontend/package.json`, lockfile | Local `@panino/content-merge` dependency |
| `backend/api-service/package.json`, lockfile | Local package dependency, ready for COLLAB-05 |
| Root test scripts, Dockerfiles and Compose build/dev mounts | Shared-package test, repository-root build contexts and source layout |

No backend runtime or CRR schema changes.

---

## 8) Tests

`shared/contentMerge.js` is pure application logic and carries the bulk of the coverage.

`shared/tests/contentMerge.test.js` — table-driven under Node, with the same exported vectors imported
by one frontend Vitest compatibility test:

- disjoint paragraph edits → clean merge containing both
- identical edits on both sides → clean, no duplication
- same-line edits → conflict, both versions preserved in the result
- pure append on both sides → clean
- one side deletes a section the other edited → conflict
- empty base (new document on both sides) → conflict, nothing lost
- `null`/`undefined` content normalized to `""`
- trailing-newline-only difference → clean, no spurious conflict
- very large document (~1MB) completes within a sane budget
- browser and Node produce the same normalized UTF-8 SHA-256 hashes

`frontend/tests/unit/syncMerge.test.js`:

- base absent → accepts theirs, records base, no merge attempted
- base absent + differing local value → conflict, never accepts theirs silently
- write-back capability absent/false + divergence → preserves both sides, performs no automatic write
- `mine === base` → accepts theirs silently
- clean merge → `updateFileContent` called once with merged text; base updated
- conflicted merge → database retains theirs; no write; conflict recorded
- open-and-dirty document → merge uses the draft, not the database value
- oscillation cap → fourth write-back within a minute is suppressed and logged
- orphan pruning removes base rows for deleted documents
- merge write-back schedules and completes a follow-up sync
- remote apply, base/conflict persistence and write-back roll back together on failure
- `db.onUpdate` during the extended transaction schedules no concurrent sync
- delete/content race preserves local content in a recoverable conflict
- JSON, ZIP, StackEdit and SQLite export/import exclude both local-only tables
- write-back guard resets after 60 seconds and after manual resolution

Manual validation: two browsers, both offline, edit different paragraphs of one document, bring
both online, confirm both paragraphs survive on both devices.

---

## 9) Risks

- **Line-level merges can still produce nonsense.** Two people rewriting adjacent lines merge
  "cleanly" into text neither wrote. This is inherent to three-way merge; it is strictly better
  than deleting one side, and it is why COLLAB-05 adds presence.
- **`pk` parsing client-side.** The packed primary-key format is CR-SQLite internal. The shared
  helper must never guess; an unparseable divergent row becomes a recoverable conflict rather than
  silently accepting `theirs`.
- **Merge cost on a large sync batch.** A client returning after a long offline period may have
  hundreds of changed documents. Merge lazily — only documents whose base differs — and yield
  between documents so the UI does not freeze.
