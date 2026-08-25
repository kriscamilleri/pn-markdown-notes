# COLLAB-01 — Editor Conflict Safety

Agent: Zed coding agent
Start: 2026-08-16 22:15 +02:00
Status: Complete

## Objective

Implement COLLAB-01: stop the open editor from silently destroying remote edits. This is the
P0 active data-loss bug in the collaboration spec set and the permanent fallback path for
every later spec.

## Progress

- Read the canonical handbooks (`AGENTS.md`, `frontend/AGENTS.md`,
  `backend/api-service/AGENTS.md`) and the full COLLAB spec set.
- Traced the bug path: `syncStore.refreshData → structureStore.reFetchSelectedFile →
  selectedFile.value` replacement, with `Editor.vue`'s content watch keyed only on
  `file.value?.id`, so a same-id remote content change never reaches the open editor and is
  clobbered by the next `debouncedSyncToDB` (`docStore.updateFileContent`).
- Established the frontend baseline: `cd frontend && npm test` → 372 tests passing across 25
  files.

## Changes Made

_(in progress)_

## Tests

- `cd frontend && npm test`
  - Passed: 388 tests in 26 files (including 16 new `editorConflictSafety` tests).
- `cd frontend && npm run build`
  - Passed: 1728 modules transformed, production build succeeds.
- `npm run lint`
  - No errors or warnings reported for the changed files.

## Open Items / Notes

- COLLAB-02 will promote the in-memory `draftStore` base to the durable `note_sync_base`
  table; the in-memory base in this spec is anticipated by that design.
- `docStore.isSaving` had no `.vue` consumer before; this spec adds the first such surface.
- Two-browser manual reproduction (§2) requires the full Docker dev stack and is deferred:
  the sandbox blocks outbound network for image pulls and the terminal does not run
  long-lived dev servers. The classification logic is unit-tested and the build compiles.
