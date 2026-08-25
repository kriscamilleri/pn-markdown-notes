# COLLAB-04 Phase 0 design artifacts

- Agent: DeepSeek V4 Pro
- Started: 2026-08-17 06:16
- Status: complete; artifacts awaiting Phase 0 approval

## Objective

Produce the five COLLAB-04 Phase 0 approval artifacts that gate Phases 2–6 — authorization
matrix, `_spaces.db` invariants, transfer state diagrams, migration/compatibility matrix, and
atomic backup/restore procedure — grounded in the landed Phase 1 code rather than restating the
spec in the abstract.

## Progress

- Re-read the landed Phase 1 code (`db.js`, `spaces.js`, `sync.js`, `backup.js`) and the sync,
  data-model, auth, and deployment architecture docs to ground every claim.
- Wrote `docs/specs/proposed/collab-04-phase-0-design-artifacts.md` with the five artifacts,
  each marked **implemented** or **specified, not yet implemented** against the current code.
- Verified a durable gap in the production database backup path: it does not capture space
  content databases or uploads (details below).
- Added a forward-looking note to `docs/runbooks/deployment.md` flagging that gap.

## Changes Made

- `docs/specs/proposed/collab-04-phase-0-design-artifacts.md` — new. Five sections:
  1. Authorization matrix — 26 operations across owner/editor/non-member/anonymous with failure
     modes (404 vs 403 vs 409 vs 401 vs 426), plus the server-enforcement and auth-source rules.
  2. `_spaces.db` invariants — 12 invariants with enforcement points; documents the missing
     foreign keys in `SPACES_SCHEMA_V1` and the not-yet-asserted owner-agreement (I2/I3) as gaps
     to close in Phase 2; specifies an `assertSpacesInvariants()` checker.
  3. Transfer state diagrams — mermaid state machines for ownership transfer and cross-database
     content transfer, with abort/recoverable-duplicate states.
  4. Migration/compatibility matrix — schema floors and the old/new client × schema × flag axes
     with fail-closed outcomes.
  5. Atomic backup/restore procedure — the all-or-nothing consistency contract and the verified
     gap in `stream-database-backup.mjs`.
- `docs/runbooks/deployment.md` — added a short note that the current backup does not cover
  `data/spaces/` or `uploads/spaces/` and must be extended before the flag is enabled.

## Tests

No automated tests were run — this is a documentation-only change with no behavior delta. Every
claim was verified by reading the source it references:

- `initializeContentDb` kind/version fail-closed behavior — `db.js:589-623`.
- `initializeSpacesDb` ordered migration and version ceiling — `db.js:827-843`.
- Owner/editor enforcement and no-owner-removal — `spaces.js` (`requireOwner`, `requireEditorRole`,
  `removeEditorMember`).
- `listSpacesForUser` filtering `status='active'` — `spaces.js:216-230`.
- `SPACES_SCHEMA_V1` has no foreign keys — `db.js:775-811`.
- Backup enumeration is flat and skips `spaces/` — `stream-database-backup.mjs:listDatabaseFiles`
  and `createTarHeader` (rejects `/` in names).

## Open Items / Notes

- The five artifacts are **proposed and awaiting Phase 0 approval** (COLLAB-00 §7 gate 6). Nothing
  in Phases 2–6 should start until they are approved.
- Durable finding for Phase 6: `stream-database-backup.mjs` enumerates only flat `*.db` in
  `/app/data`. It captures `_spaces.db` (mislabeled as a user database) but misses
  `data/spaces/{spaceId}.db` and `uploads/`, and its flat tar format cannot represent the
  `spaces/` subdirectory. This is latent while `SHARED_SPACES_ENABLED=false`; it must be closed
  before the flag is enabled in production. Recorded in the runbook and the artifact doc §5.2.
- The `_spaces.db` schema has no foreign keys and no cross-file FK is possible to `_users.db`;
  the invariant checker specified in §2.3 must cover referential integrity before Phase 5
  (ownership transfer) ships.
- COLLAB-05 remains deferred; the Yjs spikes have not been scheduled.
