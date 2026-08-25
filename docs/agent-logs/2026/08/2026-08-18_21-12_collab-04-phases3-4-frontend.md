# COLLAB-04 Phases 3–4 frontend multi-database support

- Agent: Codex (GPT-5)
- Started: 2026-08-18 21:12 CEST
- Status: complete

## Objective

Implement COLLAB-04 Phase 3 (frontend database registry, independent replica identity and
clocks, membership discovery/bootstrap, sequential sync, and v1 WebSocket subscriptions) and
Phase 4 (explicit database-scoped repositories, unified personal/space tree, aggregated
dashboards, and safe bootstrap/recovery UX) on `feature/collab`. Preserve all personal-document
behaviour and keep `SHARED_SPACES_ENABLED=false` by default. Phases 5–6 lifecycle, invite,
space-image/revision, and cross-database-transfer work remains out of scope.

## User Journeys

| # | Persona | Journey | Acceptance criteria |
|---|---|---|---|
| U1 | Existing user | Opens Panino after upgrading | Personal DB initializes first; the legacy clock migrates once to the canonical personal key; personal tree and editing remain available without waiting for space discovery. |
| U2 | Space member | Starts Panino with one or more memberships | Membership pages are fetched, spaces bootstrap one at a time, progress is visible, each replica has its own DB/site ID/clock, and initialized spaces appear below the personal tree. |
| U3 | Offline editor | Reconnects with changes in personal and shared databases | Databases sync sequentially; one failure does not block later entries; only successful databases advance their clocks. |
| U4 | Continuously online member | Membership changes while connected | A changed membership version or revocation message refreshes discovery, unsubscribes/removes revoked DBs, clears queued work, and does not retry the revoked database. |
| U5 | Space member with constrained storage | Space bootstrap hits a browser quota failure | Personal content remains usable; the failed space shows a recoverable state and Retry/Remove actions; retry resumes one-at-a-time bootstrap without claiming success. |
| U6 | Document user | Selects, renames, deletes, creates, moves, or expands a tree node | The node-to-db index routes the action to its owning repository; same-DB movement remains intact and cross-DB movement is rejected until Phase 6. |
| U7 | Dashboard user | Opens Recent Documents or a folder | Queries run against the intended databases, rows are tagged with visibility/space metadata, and global sorting/limits occur only after the per-DB results are merged. |
| U8 | Collaborator | Opens a shared document | The tree root uses the existing avatar stack and the editor/dashboard clearly identify the space and shared visibility using “Document” terminology. |

## Progress

- Read root/frontend/backend agent guidance, the feature-development skill, COLLAB-00,
  COLLAB-04 (especially §§5–6), Phase 0 design artifacts, the Phase 2 agent log, and current
  sync/data-model architecture docs.
- Confirmed the branch is clean at `37bd1af` and `SHARED_SPACES_ENABLED` remains fail-closed.
- Mapped frontend ambient DB call sites and current tree/dashboard/editor/WebSocket flows.
- Identified one required compatibility gap: Phase 2 has internal membership queries but no
  authenticated paginated read endpoint from which Phase 3 can discover space databases. The
  implemented endpoint exposes discovery only, not lifecycle or invite mutations.
- Implemented utilities first, then registry/scoped stores, then the unified UI, with focused
  tests alongside each layer as required by the feature-development skill.
- Audited all frontend ambient database access and converted document operations to canonical,
  explicit repository scopes. Personal-only image/revision/import/settings adapters now reject
  shared scopes instead of calling an unqualified backend route.
- Ran a two-account disposable browser stack. The first pass found that a brand-new replica
  collapsed “no local row” into an empty local body and recorded a false no-base conflict. Added
  an explicit `hasMine` distinction and regression test, then repeated the pass successfully.
- The complete backend run exposed a startup race between parallel test workers inserting the
  same `_spaces.db` migration marker. Made the idempotent schema migration marker use
  `INSERT OR IGNORE` and moved the busy timeout before initialization; the full rerun passed.

## Changes Made

- Added strict database-key, per-key clock migration, sequential-work, dashboard merge, quota,
  membership reconciliation, and scoped-repository utilities.
- Reworked `syncStore` into a reactive database registry. Every entry owns its CR-SQLite handle,
  database-reported site ID, persisted clock, apply/sync flags, metadata, and recovery state.
  Personal initialization finishes before asynchronous paginated discovery; spaces bootstrap one
  at a time and later spaces continue after one quota failure.
- Added per-database sequential sync failure isolation, changed-version membership refresh,
  revoked-entry queue cleanup/close/unsubscribe, v1 subscribe/resubscribe handling, and dbKey-routed
  WebSocket pokes. Subscribe acknowledgements use the server's actual `{type:'subscribe', ok:true}`
  envelope. Clock persistence occurs only after apply, merge-base, and required membership refresh
  work succeeds.
- Added authenticated, flag-gated `GET /spaces` membership discovery with stable cursor pagination,
  membership/schema versions, and profile-safe `{id,name}` member data. No lifecycle or invite
  mutation was exposed. Exported the existing content schema version for the response.
- Replaced ambient database access in structure/document/template/global/conflict/image/revision/
  import-export and preference flows. Application writes use scoped repository transactions;
  missing or noncanonical scope fails loudly.
- Built a unified personal + shared-space tree with a node-to-database index, personal roots first,
  existing `AvatarStack`, per-space recovery actions, correctly routed CRUD/selection/children, and
  same-database moves. Cross-database moves are rejected with a visible warning.
- Aggregated Recent Documents across initialized databases in JavaScript, with database/space tags
  applied before global sorting and limiting. Folder dashboards and templates retain their selected
  database scope.
- Added shared visibility labels to dashboard rows/cards and editor metadata. The metadata bar wraps
  inside the editor pane. Shared image/revision operations are explicitly unavailable until Phase 6.
- Updated the frontend/backend agent references and durable data-model/sync documentation.
- Hardened `_spaces.db` initialization against concurrent idempotent migration startup.

## Tests

- `npm run lint` — passed.
- `npm run test:fe` — passed, 38 files / 470 tests.
- `npm run build` from `frontend/` — passed; only the existing Vite dynamic-import and chunk-size
  warnings were emitted.
- `npm run test:be` — final Docker/Node 24 run passed, 20 files / 259 tests. The first full run
  exposed the `_spaces.db` migration-marker race described above; it was fixed before the clean run.
- `npx vitest run tests/unit/db.test.js tests/integration/spaces.discovery.test.js
  tests/integration/sync.spaces.test.js` — passed, 55 tests (focused compatibility run).
- Focused frontend registry/tree/dashboard/UI/merge runs passed during implementation, including
  legacy clock migration, independent site IDs/clocks, sequential failure continuation, pagination,
  quota continuation/retry, revocation cleanup, v1 resubscription/routing, scoped-context failure,
  global dashboard merge order, space roots/labels, and first-remote-row adoption.
- Disposable Docker browser validation with `SHARED_SPACES_ENABLED=true` only in that isolated
  stack — passed for two accounts. At 375px, the owner saw a private Document, `Writers Room` with
  the existing avatar stack, and `Shared Plan`. At 1280px, the editor saw the same tree and opened
  `Shared Plan`; metadata showed `Document`, `Shared with space members`, and `Writers Room`.
  Browser console/page-error collection was empty at both widths. The isolated project used
  dedicated `/tmp` data/upload paths and distinct ports; its containers, volumes, databases,
  uploads, script, and screenshots were removed after validation. The existing dev stack was not
  restarted or accessed.

## Open Items / Notes

- `SHARED_SPACES_ENABLED` remains `false` by default.
- Phase 5 still owns public space lifecycle, invite, and member-management UI/routes.
- Phase 6 still owns cross-database transfer plus space-qualified image and revision routes.
- No unresolved blocker remains for Phases 3–4.
