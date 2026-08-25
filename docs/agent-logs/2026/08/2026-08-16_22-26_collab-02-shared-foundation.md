# COLLAB-02 Shared Foundation — @panino/content-merge

Agent: Zed coding agent
Start: 2026-08-16 22:21 +02:00
Status: In progress

## Objective

Create the repository-local `@panino/content-merge` package that owns normalization, hashing,
three-way merge, conflict-hunk serialization, budgets and test vectors, and wire it into both
applications plus the Docker/Compose build contexts (COLLAB-00 §4, COLLAB-02 §5.1).

## Progress

- Created `shared/` as a standalone ESM package pinned to `node-diff3@3.2.1`.
- Implemented `normalizeContent`, `contentHash` (Web Crypto SHA-256), `mergeContent` (line
  three-way merge), `serializeConflictHunks`, and merge budgets (1 MiB / 50 documents).
- Declared `@panino/content-merge` via `file:` deps in frontend and backend package manifests and
  regenerated both lockfiles.
- Added root `test:shared` and made `npm test` run shared tests first.
- Switched api-service and frontend Docker/Compose builds to a repository-root context and added
  `shared/` copies plus dev bind mounts; added a root `.dockerignore`.

## Changes Made

- `shared/package.json`, `shared/contentMerge.js`, `shared/tests/contentMerge.test.js` (new)
- `package.json` (test:shared), `frontend/package.json` + lock, `backend/api-service/package.json` + lock
- `docker-compose.yml`, `docker-compose.dev.yml`, `.dockerignore` (new)
- `backend/api-service/Dockerfile`, `backend/api-service/Dockerfile.test`, `frontend/Dockerfile.dev`
- `scripts/test-backend.sh`

## Tests

- `cd shared && npm test` → 18 tests pass (normalization, hashing vectors, disjoint/identical/
  same-line/append/delete-vs-edit/empty-base/trailing-newline/budget merges, hunk serialization).
- `cd frontend && npm test` → 409 tests pass (unchanged; shared package linked but not yet imported
  by frontend application code).
- Spot-checked `contentHash('')` and `contentHash('hello')` against known SHA-256 vectors.

## Open Items / Notes

- Docker/Compose context changes are **not verified in this sandbox** — no Docker daemon and no
  outbound network for image pulls. They follow the `file:`-to-`/shared` layout but must be validated
  in CI before merge. The host-based shared/frontend tests are the verified evidence.
- The next step is the COLLAB-02 sync-time merge dispatch in `syncStore.sync()` and the
  `note_sync_base`/`note_conflicts` schema.
