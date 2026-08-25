# COLLAB-04 Phase 6 production recovery tooling

- Agent: Codex (`phase6_ops`)
- Started: 2026-08-18 22:20 Europe/Malta
- Status: complete

## Objective

Close the approved Phase 0 disaster-recovery gap before shared spaces can be enabled in
production: include `_spaces.db`, all shared-space databases, and shared-space uploads in the
streamed backup; provide a safe staged restore and invariant check; document the maintenance
procedure; and state clearly that the personal GitHub backup excludes shared spaces.

## Progress

- Verified that production Compose mounts the API data and uploads volumes at
  `/app/backend/api-service/data` and `/app/backend/api-service/uploads`. The backup script
  incorrectly targeted `/app/data`, which is not the mounted production data path.
- Extended the stream format from flat database names to safe nested restore paths with a
  versioned manifest, entry sizes, and SHA-256 hashes.
- Added staged extraction and read-only revalidation with path containment, manifest, SQLite,
  membership, and complete-space-set checks.
- Updated operator documentation and GitHub Backup UI copy.

## Changes Made

- Production backups now order and include space metadata, space content databases, space
  uploads, personal databases, and auth metadata. Diagnostic selections are explicitly marked
  non-restorable as a complete estate.
- Archive creation rejects unsafe/non-ASCII/traversing paths, non-UUID space storage roots,
  symlinks, unsupported upload entries, and source files changed during streaming.
- `stage-production-restore.mjs` verifies the companion checksum before extracting into a
  private temporary directory. It verifies space image rows against their stored bytes,
  publishes the requested staging directory only after all checks pass, and supports
  `--verify-dir` for a read-only maintenance-window recheck.
- `assertSpacesInvariants()` accepts an optional staged auth database while preserving its
  live default.
- The GitHub Backup modal now says shared spaces are excluded and protected by separate server
  disaster-recovery backups.

## Tests

- `node --check scripts/production-database-backup/stream-database-backup.mjs` — passed.
- `node --check scripts/production-database-backup/stage-production-restore.mjs` — passed.
- `bash -n scripts/production-database-backup/backup-production-databases.sh` — passed.
- `npx vitest run tests/unit/stream-database-backup.test.js tests/unit/production-restore.test.js tests/unit/spaces.test.js --reporter=verbose` from `backend/api-service` — 60 passed.
- `npx vitest run tests/unit/documentTerminology.test.js --reporter=verbose` from `frontend` — 2 passed.
- Targeted ESLint over the changed scripts, backend files/tests, and frontend copy/test — passed.

## Open Items / Notes

- No production connection, backup, restore, volume write, or service restart was performed.
- The frontend change is disclosure copy inside the existing modal. Isolated flag-enabled browser
  validation remains part of the parent Phase 6 integration pass.
- A real restore drill still requires current-conversation approval, a fresh verified backup,
  resolved Docker volume targets, stopped API traffic, and the complete-pair rollback procedure
  in `docs/runbooks/deployment.md`.
- Shared spaces remain disabled by default.
