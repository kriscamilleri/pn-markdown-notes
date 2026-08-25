# COLLAB-02 persisted conflict resolution

- Agent: GPT-5.6 Sol
- Started: 2026-08-16 20:42
- Status: complete

## Objective

Finish COLLAB-02 §6.2 with an in-editor per-region **Keep mine** / **Use theirs** workflow for persisted `note_conflicts`, and verify the repository-root Docker/shared-package wiring that had not previously been exercised.

## Progress

- Read the root, frontend, and backend agent handbooks plus COLLAB-02, COLLAB-04, and COLLAB-05.
- Confirmed the branch started clean at `2d91dd7`.
- Reproduced the backend Docker build failure and traced it to flattening `backend/api-service` to `/app`: npm 11.17 rejected the location-dependent `file:../../shared` lock target.
- Added and validated the persisted conflict resolution workflow.
- Preserved the repository-relative backend/shared layout in Docker and Compose.

## Changes Made

- Added ordered conflict-resolution plans and explicit per-region application to `@panino/content-merge`; clean regions remain in the plan so duplicate text, deletions, and trailing newlines reconstruct correctly.
- Added `ConflictResolutionModal.vue`, reusing `DiffView.vue`, with per-region choices, a single Apply action, clean-candidate review, and an over-budget whole-document fallback.
- Extended `conflictStore` with lazy detail loading and an atomic resolution transaction that:
  - writes an ordinary `notes.content` change;
  - updates `note_sync_base`;
  - resets the write-back oscillation guard;
  - deletes `note_conflicts`;
  - rejects a stale reviewed record and rolls back on any failure.
- Wired persisted conflicts into COLLAB-01's Editor banner and cursor-preserving programmatic update path. Editing remains held until resolution commits.
- Added shared, store, modal, and Editor wiring coverage.
- Updated backend Docker images and Compose mounts to use `/app/backend/api-service` and `/app/shared`, matching the committed `file:../../shared` lockfile relationship.
- Changed the frontend dev image to explicit lockfile copies plus `npm ci`.
- Applied two minimal lint-only cleanups in previously landed collaboration tests/scripts so the required root lint command is green.

## Tests

- `cd shared && npm test` — 25 passed.
- `cd frontend && npm test` — 446 passed.
- `cd frontend && npm run build` — passed; existing Vite chunk/dynamic-import warnings remain.
- `npm run lint` — passed.
- `npm run test:be` — 177 passed in the Node 24 Docker image.
- `docker build -f frontend/Dockerfile.dev -t panino-frontend-dev .` — passed; frontend `npm ci` and local shared dependency verified.
- `docker compose -f docker-compose.dev.yml build` — both services built successfully; Compose reports its existing obsolete `version` warning.
- A runtime `docker compose up` was not performed because the development compose file bind-mounts the repository's excluded `backend/api-service/data` and `uploads` directories; starting it could initialize or migrate real local data. Image builds and the isolated backend test container exercised the corrected install/runtime layout without touching those directories.

## Open Items / Notes

- Browser/manual two-replica validation still requires a disposable dev data stack.
- COLLAB-04 Phase 0 approval artifacts described by the proposed spec are not present. Phase 1 work should keep public admission disabled and record that gate explicitly.
- COLLAB-05 remains deferred until the OverType↔Y.Text binding and crash-recovery spikes pass.
