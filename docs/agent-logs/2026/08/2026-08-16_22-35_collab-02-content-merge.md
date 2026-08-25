# COLLAB-02 — Content Merge (client sync path)

Agent: Zed coding agent
Start: 2026-08-16 22:30 +02:00
Status: In progress

## Objective

Implement the client-side three-way merge at sync boundaries so non-overlapping offline edits
merge automatically instead of one side silently overwriting the other. No backend runtime or CRR
schema change; the merge is client-local and fail-closed behind the server
`contentMergeWriteback` capability.

## Progress

- Added `frontend/src/utils/crsqlitePk.js` (packed-pk parsing mirroring the backend `parsePkId`).
- Added `frontend/src/utils/syncMerge.js` (pure merge dispatch + oscillation write-back guard).
- Added `note_sync_base` and `note_conflicts` local-only tables to `DB_SCHEMA`.
- Rewrote `syncStore.sync()` to capture `mine`/`theirs` around the remote-apply transaction,
  resolve each changed document, write merge results/conflicts/base atomically, and schedule a
  single follow-up sync after a write-back. `onUpdate` now records a follow-up instead of
  re-entering `sync()` while the remote-apply guard is set.
- Seeded bases on document creation/duplication and on local commit; added a post-sync
  `seedMissingMergeBases` migration for upgraded clients.
- Added `LOCAL_ONLY_TABLES` to `importExportStore` so `note_sync_base`/`note_conflicts` never
  leave the device through export.

## Changes Made

- `frontend/src/store/syncStore.js`, `docStore.js`, `structureStore.js`, `importExportStore.js`
- `frontend/src/utils/crsqlitePk.js`, `syncMerge.js` (new)
- `shared/contentMerge.js` (eslint globals for `TextEncoder`/`crypto`)
- Tests: `crsqlitePk.test.js`, `syncMerge.test.js`, `importExportLocalOnly.test.js` (new)

## Tests

- `cd shared && npm test` → 18 tests pass.
- `cd frontend && npm test` → 430 tests pass across 32 files (includes new pk/merge/export tests).
- `cd frontend && npm run build` → production build succeeds; `@panino/content-merge` resolves and
  bundles (main bundle grows to ~826 kB).
- `npx eslint` on changed frontend/shared files → clean.

## Open Items / Notes

- `contentMergeWriteback` remains false until the server advertises it, so automatic write-back is
  fail-closed as required; divergence is preserved in `note_conflicts`.
- Unresolved-conflict markers now render on `TreeItem` and `RecentDocumentRow` via `conflictStore`,
  and `docStore.refreshData` reloads the set after sync. Per-hunk Keep-mine/Use-theirs resolution
  UI (COLLAB-02 §6.2) is still deferred; the conflict records are persisted and recoverable.
- Docker context changes from the previous commit remain unverified in this sandbox.
