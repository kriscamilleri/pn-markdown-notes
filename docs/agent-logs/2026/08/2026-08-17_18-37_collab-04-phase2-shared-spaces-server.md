# COLLAB-04 Phase 2 shared-spaces server capability

- Agent: Copilot CLI (GPT-5.6-class)
- Started: 2026-08-17 ~14:00 (session start; this log written 2026-08-17 18:37)
- Status: complete behind disabled flag

## Objective

Implement the COLLAB-04 Phase 2 server capability on `feature/collab`, on top of `552f316`
(Phase 0 approval docs, untouched): an invariants checker for the space-metadata repository, a
non-disclosing membership/access resolver shared by sync and WebSocket, space-aware `POST
/sync` with a strict change-batch allowlist, backend-only revision actor attribution, and the
COLLAB-00 v1 WebSocket subscribe/unsubscribe protocol — all fail-closed behind
`SHARED_SPACES_ENABLED=false`, with personal (non-space) behavior wire-compatible and
unchanged. Explicitly out of scope: public space membership routes, frontend registry/UI,
images/revisions routes, invites/transfers/ownership lifecycle, and backup producer changes.

Required reading before implementation: `AGENTS.md`, `backend/api-service/AGENTS.md`,
`docs/specs/proposed/collab-00-overview.md` §4 (WebSocket contract),
`docs/specs/proposed/collab-04-shared-spaces.md` §3-4/§7-8, and
`docs/specs/proposed/collab-04-phase-0-design-artifacts.md` §1-2.

## User journeys covered

- **Owner/editor space sync**: an authenticated member posts a change batch with a `space`
  UUID; the server validates active membership before opening the space content DB, merges
  only allowlisted tables/columns, stamps `note_revisions.actor_user_id`/`actor_kind` from the
  JWT (never from the client), skips the personal GitHub auto-backup path, and returns the
  space's current `membershipVersion` alongside the usual `{changes, clock, skipped}` shape.
- **Nonmember / unknown space / flag disabled**: all three return an identical, non-disclosing
  404 `{error:"Not found", code:"SPACE_NOT_FOUND"}` — a nonmember cannot distinguish "space
  doesn't exist" from "space exists but you're not in it" from "shared spaces are disabled".
- **Prohibited batch**: a batch touching a disallowed table (`users`) or a disallowed column
  (`notes.user_id`) is rejected whole with 400 `{code:"SPACE_CHANGE_NOT_ALLOWED"}` before any
  row is merged; a merge-time failure (simulated orphan clock row) invalidates only the
  `space:<uuid>` connection, leaving the same caller's cached `user:<uuid>` connection intact.
- **Personal sync unaffected**: omitting `space` produces byte-identical responses to the
  pre-Phase-2 shape (no `membershipVersion` field, no actor gating change, backup path
  untouched).
- **Live collaboration over WebSocket**: a client opens the legacy `?token=&siteId=` handshake
  (unchanged) with zero subscriptions, then sends a v1 `subscribe` envelope for its personal
  `user:<uuid>` dbKey and/or one or more `space:<uuid>` dbKeys it belongs to. A subsequent
  space sync pokes only the other currently-authorized subscribers of that exact dbKey
  (excluding the poking site id) with `{v:1,type:'sync',payload:{dbKey}}`; a subscriber whose
  membership was revoked between subscribing and the poke is dropped and told
  `subscription:revoked` instead of receiving a stale sync hint. Malformed/unsupported
  messages get a versioned error and never mutate subscription state, so a client can safely
  retry.

## Changes Made

- `backend/api-service/spaces.js`
  - Added and exported `assertSpacesInvariants(db, {throwOnViolation=true})`, checking (per
    Phase 0 design artifact §2.3): exactly one owner per space, orphaned memberships/invites
    referencing a missing space, memberships/owners referencing a missing auth user (`space_invites`
    has no user reference — it stores only an invitee `email` — so this check applies to
    `space_members`/`spaces.owner_user_id`, not to invites),
    `status`/`deleted_at` pairing consistency, missing `space_user_versions` rows for
    owners/members, and duplicate-owner rows. Violations raise
    `SpaceRepositoryError('SPACE_INVARIANT_VIOLATION', ...)` when `throwOnViolation` is true;
    the thrown error carries internal diagnostic detail but route-level handlers never surface
    it verbatim to HTTP callers.
  - Wired the checker into `createSpace`, `addEditorMember`, and `removeEditorMember` so it
    runs inside the same transaction, immediately before commit — a violation aborts the
    transaction instead of persisting.
  - Added and exported `resolveSpaceAccess(spaceIdOrOptions, actorUserId)` (accepts either
    positional `(spaceId, actorUserId)` args or a single `{spaceId, actorUserId}` options
    object; calls `getSpacesDb()` internally, no `db` parameter) and
    `getSpaceMembershipVersion(userId)` (a single per-user scalar from
    `space_user_versions`, not scoped to one space): UUID-validated, flag-gated
    (`SHARED_SPACES_ENABLED`), checks active membership against the **authenticated actor**
    (never a client-supplied user id), and return `null`/`0` for ordinary no-access cases
    (disabled flag, invalid UUID, no membership row) rather than detail that would let a
    caller distinguish "no such space" from "not a member". Operational failures (e.g. the
    metadata DB itself erroring) now propagate as thrown exceptions rather than being coerced
    into that same success-shaped `null`/`0` — see the review-follow-up note below. Used
    directly by both `sync.js` and `websocket.js`.
  - `membershipQuery` now filters `AND s.status = 'active'` so a soft-deleted/suspended space
    cannot be resolved as accessible.
- `backend/api-service/db.js`
  - Added a backend-only, nullable `actor_user_id TEXT` / `actor_kind TEXT` pair to
    `note_revisions` in `BASE_SCHEMA` (fresh installs) and in `ensureNoteRevisionsSchema`'s
    three-branch migration (legacy unversioned, versioned-but-missing-columns, already-current)
    so both fresh and pre-existing databases converge on the same shape idempotently.
- `backend/api-service/revision.js`
  - Added `ACTOR_KINDS` (`sync`, `collab`, `system`) and `validateActorKind`.
  - `createRevisionSnapshot`/`createRevisionRowPayload` accept optional `actorUserId`/
    `actorKind`, validate the kind against the allowlist, and persist them; omitted values stay
    `NULL` (personal/non-space call sites are unaffected).
- `backend/api-service/sync.js`
  - Added an optional `space` body field to `POST /sync`. Absent → personal behavior,
    unchanged wire shape.
  - Present → `SHARED_SPACES_ENABLED` gate, then `resolveSpaceAccess` against the JWT actor
    *before* opening the space content DB; unknown space, disabled flag, and non-membership
    all return the same 404 `SPACE_NOT_FOUND`.
  - Added `SPACE_CHANGE_ALLOWLIST` (folders, notes — including `pinned` — globals, templates,
    and the tombstone sentinel column `cid:"-1"`) and `validateSpaceChangeBatch`, run over the
    **entire** incoming batch before any merge is attempted; any disallowed table, column, or
    malformed/tombstone-shaped row rejects the whole batch with 400
    `{code:"SPACE_CHANGE_NOT_ALLOWED"}` and merges nothing.
  - On merge failure, invalidates only the exact `dbKey` involved (`space:<uuid>` or
    `user:<uuid>`), not any other cached connection for the same caller.
  - Space syncs skip `triggerDailyAutoBackup` (no per-space backup producer exists yet — see
    Open Items).
  - Server-derived `actor_user_id`/`actor_kind: 'sync'` are passed into revision creation only
    for space syncs; any client-supplied actor-shaped fields in the request body are ignored.
  - Successful space-sync responses include the space's current `membershipVersion`; personal
    responses do not gain this field.
  - Delegates to `websocket.js`'s poke helpers (`pokePersonalClients` for personal syncs,
    `pokeSpaceSubscribers` for space syncs) instead of directly touching the WS clients map.
- `backend/api-service/websocket.js` (new)
  - `WS_PROTOCOL_VERSION = 1`; `isValidSiteId` enforces `^[0-9a-f]{32}$` (stricter than the
    legacy handshake's free-form `siteId` query param, which is unchanged for compatibility).
  - `createClientState` gives every new connection an **empty** subscriptions map (legacy
    same-user poke behavior is preserved separately, not via an implicit subscription record).
  - `handleSubscribe`/`handleUnsubscribe` validate a whole batch atomically: a UUID
    `requestId`, per-item `dbKey` authorization (`user:<uuid>` only if it matches the JWT
    actor; `space:<uuid>` only via `resolveSpaceAccess`) and `siteId` format, capacity (100
    space + 1 personal), and same-`dbKey`-different-`siteId` conflicts — any single-item
    failure discards the entire batch, so the client's committed state never partially
    advances. Successful subscribes are idempotent (re-subscribing the same `dbKey`+`siteId`
    is a no-op) and echo back the resulting `subscriptions` plus `membershipVersion` where
    applicable.
  - `handleClientMessage` caps control frames at 64KiB, replies with a versioned, non-mutating
    error for unsupported `v`, missing/malformed `requestId`, unknown `type`, or malformed
    JSON — the connection is left fully usable afterward.
  - `pokePersonalClients` preserves the legacy "poke all other same-user sockets" behavior.
    `pokeSpaceSubscribers` pokes only sockets currently subscribed to the exact `dbKey`,
    excluding the poking site id, re-checking membership at poke time and, for now-unauthorized
    subscribers, removing the subscription and emitting `{v:1,type:'subscription:revoked',...}`
    instead of a stale sync hint.
  - `attachWebSocketHandlers` enforces a 4MiB `bufferedAmount` backpressure close and a
    per-user connection cap (`MAX_CONNECTIONS_PER_USER = 10`); no user IDs are logged anywhere
    in this module.
- `backend/api-service/index.js` — wires `attachWebSocketHandlers` into the existing WS server
  setup alongside the legacy handshake.
- `backend/api-service/AGENTS.md` — updated the module map (new `websocket.js` row; `sync.js`,
  `spaces.js`, `revision.js` rows expanded for Phase 2 behavior), rewrote the "WebSocket
  Protocol" section to document the v1 envelope, and updated the test directory listing to
  include the new/previously-undocumented test files.
- Tests (see below) — `tests/unit/spaces.test.js` extended, `tests/unit/db.test.js` extended,
  new `tests/unit/revision.test.js`, new `tests/integration/sync.spaces.test.js`, new
  `tests/integration/websocket.spaces.test.js`.

Root `AGENTS.md` schema-change rule was followed: the new `note_revisions` columns are
backend-only and do not require a `frontend/src/store/syncStore.js` `DB_SCHEMA` change, since
the frontend never writes these columns directly (they are populated server-side by the
sync/revision pipeline). No entries were added to `CRR_TABLES` — `note_revisions` is not (and
does not need to become) a CRR table for this change.

## Tests

Run natively from `backend/api-service` (`npx vitest run ...`), not via `npm run test:be`
Docker — the task allowed "narrow appropriate tests if environment permits" and native runs
were sufficient and much faster for the iteration loop this task required. All counts below
are from this repository state, uncommitted.

- Targeted, this session:
  - `tests/integration/sync.spaces.test.js` — 13/13 passed. Covers owner/editor allowed sync
    with `membershipVersion`, nonmember/unknown-space 404 parity, flag-disabled fail-closed
    404, personal-response shape parity, whole-batch rejection for a disallowed table and for
    a disallowed column (with proof of zero partial merge via empty `crsql_changes`/absent
    rows), a real tombstone merge (`cid:"-1"`, `cl:2`), server-derived actor attribution
    (ignoring client-supplied actor fields), targeted-vs-untouched connection invalidation on
    merge failure, and no personal-backup invocation for space syncs.
  - `tests/integration/websocket.spaces.test.js` — 20/20 passed. Covers empty subscriptions on
    connect, personal and space subscribe success, non-disclosing rejection of
    nonmember/unknown-space/foreign-user-key targets, atomic all-or-nothing validation (bad
    site id and unauthorized target cases), idempotent re-subscribe, same-dbKey conflicting
    site id (both across requests and within one request), malformed site id, unsubscribe
    idempotence, unsupported protocol version, malformed/missing requestId, unknown message
    type, malformed JSON (with proof the connection stays usable), space-scoped poke with site
    exclusion and bystander non-delivery, self-poke exclusion, and membership-revocation at
    poke time (subscription dropped + `subscription:revoked` emitted).
- Combined direct-impact run:
  `npx vitest run tests/integration/websocket.test.js tests/integration/websocket.spaces.test.js
  tests/integration/sync.test.js tests/integration/sync.spaces.test.js
  tests/integration/sync.revision.test.js tests/integration/revision.test.js
  tests/unit/spaces.test.js tests/unit/db.test.js tests/unit/revision.test.js` — **138/138
  passed** (9 files).
- Full native suite: `npx vitest run` (whole `backend/api-service` test tree, 19 files) —
  **250/250 passed**, run twice consecutively for stability. The first two full-suite attempts
  (before a test-only timeout adjustment, see below) each had exactly one flaky failure in
  `websocket.spaces.test.js` — a different individual test each time, always at the initial
  `openWebSocket()` connect, never at an assertion. This file opens far more WebSocket
  connections per run than the legacy `websocket.test.js`, and the flake only appeared when
  competing against the other ~18 files' concurrent DB/bcrypt/WS work in the full suite, never
  in isolation or in the 9-file combined run above. Raised `WEBSOCKET_TIMEOUT` in that test
  file from 2000ms to 8000ms (test-file-only change, no source or assertion changes); two
  subsequent full-suite runs were clean (250/250 each).
- Pre-existing, unrelated noise observed (not a regression, not acted on): a background
  revision-maintenance timer (`startRevisionMaintenanceJob`, started once per test file's
  `index.js` module instance) scans `data/` for all real per-user/per-space db files a few
  seconds after each test file's app boots. During one run this produced a one-time "duplicate
  column name: actor_user_id" console error, consistent with two parallel vitest worker
  processes both attempting the same additive `ALTER TABLE` against a shared legacy real file
  nearly simultaneously; it's caught by the job's own try/catch, doesn't fail any test, and is
  idempotent thereafter. `SQLITE_READONLY` daily-prune noise against real `data/` files is
  pre-existing and unrelated to this change. Per `AGENTS.md`, `backend/api-service/data/` is a
  "do not read" real-user-data directory and was not otherwise inspected.
- `node --check` was used to verify syntax on every new/edited JS file at least once during
  development (in particular after recovering from a display-redaction copy/paste mistake in
  the initial draft of `sync.spaces.test.js` — a tool-output artifact, not a real file
  corruption, documented for future agents' awareness but not itself a code change).

Not run this session: `npm run test:be` (Docker/Node 24 canonical run), `npm run lint`,
frontend tests, or `npm run doctor` — none of the changes touch the frontend, dependencies, or
lint configuration, and the native suite is the documented fallback when Docker is not
exercised. If a maintainer wants the canonical Docker confirmation before merging, run `npm
run test:be` from the repo root.

## Review Follow-up (same session, post-review)

A code review of the above raised five findings, all addressed before anything was committed:

1. **WebSocket subscribe payload field name.** The COLLAB-00/04 contract's subscribe request
   payload is `{databases:[{dbKey,siteId}]}`, not `{subscriptions:[...]}` as first implemented.
   Fixed in `websocket.js`'s `handleSubscribe` (reads `payload?.databases`), with an explicit
   comment that the request field (`databases`) and the success-response field (`subscriptions`)
   are deliberately different names per spec and must not be aliased for backward compatibility.
   Updated `tests/integration/websocket.spaces.test.js`'s `subscribe()` helper and two inline
   malformed-request cases to match. `backend/api-service/AGENTS.md`'s WebSocket Protocol
   section and module map were also corrected (they previously showed the request payload as
   `subscriptions` too).
2. **Strict primary-key validation for space change batches.** All four allowlisted tables
   (`folders`, `notes`, `globals`, `templates`) use a single TEXT primary key column, so
   `validateSpaceChangeBatch` now also rejects any change (tombstone or not) whose `pk` doesn't
   decode to a non-empty string via the same `parsePkId` already used for personal syncs,
   *before* any merge is attempted. Added
   `tests/integration/sync.spaces.test.js` cases for an empty-string tombstone `pk` (mixed into
   an otherwise-valid batch, proving whole-batch rejection with no partial merge, including that
   a pre-existing base row and an allowed sibling row are both left untouched) and a change
   missing the `pk` field entirely.
3. **No more success-shaped `null`/`0` on genuine metadata-DB failures.** `resolveSpaceAccess`
   and `getSpaceMembershipVersion` in `spaces.js` previously wrapped their queries in a
   try/catch that logged and returned `null`/`0` on *any* error, making a real operational
   failure indistinguishable from ordinary non-membership. Both now let such errors propagate;
   ordinary no-access cases (disabled flag, invalid UUID, no membership row found) are still
   `null`/`0` via explicit checks that never touch the DB or via a query that simply finds
   nothing. Each caller now catches at its own call site and formats a safe response: `sync.js`
   returns a generic 500 (`respondToSpaceMetadataError`, logging only `error?.code`, no
   message/stack) for both the pre-merge access check and the post-merge membershipVersion
   lookup (the latter uses an inner `try/return` so it can't be misattributed to the outer
   merge-failure/503 handler); `websocket.js`'s `isDbKeyAuthorized` reports a distinct
   `internalError` outcome (leading to a `retryable:true` `INTERNAL_ERROR` reply) separate from
   ordinary unauthorized/malformed outcomes, `handleSubscribe`'s membershipVersion lookup is
   checked before the subscription batch commits so a failure here aborts atomically with
   nothing partially applied, and `pokeSpaceSubscribers`'s per-client re-check skips (does not
   revoke, does not crash the fan-out loop) just the one client whose check errored. Added three
   `tests/unit/spaces.test.js` cases (dropping the relevant table mid-test on an in-memory DB)
   proving both functions now throw instead of returning a default.
4. **Inaccurate claims in this log and in `AGENTS.md`, corrected above/here:** `space_invites`
   has no user reference at all (only `token_hash`, `space_id`, `email`, `role`, `expires_at`,
   `used_at`, `created_at`), so the missing-auth-user invariant check never touches invites — only
   `space_members`/`spaces.owner_user_id`. `resolveSpaceAccess`'s real signature is
   `resolveSpaceAccess(spaceIdOrOptions, actorUserId)` (positional or a single options object,
   internally calling `getSpacesDb()`) — it does not take a `db` parameter. `getSpaceMembershipVersion(userId)`
   takes only a user id (a per-user scalar, not per-space). The "Changes Made" section above and
   `backend/api-service/AGENTS.md`'s WebSocket Protocol section have been corrected accordingly.
5. **`git diff --check` cleanliness.** `sync.js` had a trailing blank line at EOF; removed.
   `git diff --check` is now clean for the whole repository.

Re-run after these fixes (native `npx vitest run` from `backend/api-service`):
- `tests/integration/sync.spaces.test.js` — **15/15 passed** (13 pre-existing + 2 new malformed-pk
  cases).
- `tests/integration/websocket.spaces.test.js` — **20/20 passed** (payload field rename applied
  to both implementation and tests simultaneously; no other call site referenced the old field
  name — confirmed via a repo-wide grep).
- `tests/unit/spaces.test.js` — **29/29 passed** (26 pre-existing + 3 new operational-failure
  cases), run together with `websocket.spaces.test.js` in the same invocation: **49/49 passed**.
- `git diff --check` — clean (exit 0), repo-wide.

## Review Follow-up 2 (same session, second review pass)

A second, independent review flagged a **medium concurrent SQLite lock regression**: the
long-lived `_spaces.db` (`getSpacesDb()`) and `_users.db` (`getAuthDb()`) metadata connections
had no `PRAGMA busy_timeout` set. Since `assertSpacesInvariants` runs inside `_spaces.db` write
transactions (`createSpace`/`addEditorMember`/`removeEditorMember`) while other concurrent
requests can be reading/writing `_users.db` to resolve an actor, any lock contention on either
connection would surface as an immediate `SQLITE_BUSY` instead of retrying briefly — a
regression risk introduced by this phase's heavier use of both metadata databases from
concurrent request handlers.

Fix: added an exported named constant `METADATA_DB_BUSY_TIMEOUT_MS = 5000` in `db.js` and set
`PRAGMA busy_timeout` to that value on both connections — for `getAuthDb()`, right after
`AUTH_SCHEMA` is applied; for `getSpacesDb()`, alongside the existing `journal_mode`/
`synchronous` pragmas — in both cases after the connection's own schema initialization but
before it is cached in `dbConnections` or returned to any caller, so every subsequent use (the
only use, since both are process-wide singletons) is covered.

Added `tests/unit/db.test.js` > "Database Initialization" > "sets a bounded busy_timeout on both
the auth and shared-spaces connections", asserting
`db.pragma("busy_timeout", { simple: true })` equals the exported `METADATA_DB_BUSY_TIMEOUT_MS`
for both `getAuthDb()` and `getSpacesDb()`. `better-sqlite3`'s `busy_timeout` pragma is
synchronously readable and deterministic (no timing/flakiness risk), so this assertion is
reliable.

Re-run after this fix (native `npx vitest run` from `backend/api-service`):
- `tests/unit/db.test.js` — **37/37 passed** (36 pre-existing + 1 new; new test also isolated via
  `-t "busy_timeout"` to confirm it individually passes).
- `git diff --check` — clean (exit 0), repo-wide.
- Full native suite (`npx vitest run`, 19 files, default parallelism), **6 runs total** during
  this follow-up: the first two default-parallel runs after applying the fix each had exactly
  **one** flaky failure (255/256; a different single test each time — once a resource race
  loading the CR-SQLite native extension in `db.test.js`, once a `SqliteError: database is
  locked` inside `addEditorMember`'s write transaction against the shared `_spaces.db`
  singleton, surfaced from a *different* space-related test file). To isolate cause, the fix was
  temporarily stashed and the suite re-run twice as a baseline: **without** the busy_timeout fix,
  the same kind of full-parallel run produced dramatically more failures (22 failed / 6 files,
  then a similarly-sized failure set on the next attempt) — confirming the fix is a clear
  improvement, not a regression. Restoring the fix and re-running with
  `--no-file-parallelism` (serializing the 19 test files instead of running them as ~19
  concurrent worker processes) produced a clean **256/256**, confirming the residual flake's
  root cause: this repo's `_users.db`/`_spaces.db` metadata connections are process-wide
  singletons backed by two physical files shared by *every* test file's worker process (by
  design, unlike per-test-random-UUID content databases), so a full default-parallel run
  launches ~19 separate processes all contending on those same two files at once; `busy_timeout`
  makes that contention retry instead of failing instantly, but under maximal 32-way parallelism
  a rare single-test collision can still exceed the 5s window. Two subsequent default-parallel
  runs, back-to-back, were then clean: **256/256** and **256/256**. This residual,
  environment/parallelism-driven flake is a pre-existing characteristic of the shared-singleton
  metadata DB design (not introduced by this fix, not present under serialized execution, and
  substantially rarer with the fix than without it) — a possible future hardening (out of scope
  for this narrow fix) would be enabling WAL mode on `_users.db` (already done for `_spaces.db`)
  and/or raising the timeout further if CI ever runs with comparable parallelism.

Modified/created files added by this follow-up (on top of the set listed in the "Nothing in
this task was committed" note under Open Items below): `backend/api-service/db.js`,
`backend/api-service/tests/unit/db.test.js` (already-tracked/modified files, no new files).

## Review Follow-up 3 (same session, canonical Docker run)

The canonical `npm run test:be` (Docker, Node 24) run reported a failure at 254/256 — a
`setupTestUser` auth `INSERT` hitting `SqliteError: database is locked` **despite the 5s
`busy_timeout` from Follow-up 2 having fully elapsed**, i.e. genuine sustained lock contention
in the Docker environment exceeded 5 seconds, not merely a transient blip.

Fix: bumped `METADATA_DB_BUSY_TIMEOUT_MS` from `5000` to **`30_000`** (30s) in `db.js`, with an
updated comment explaining the larger bound is meant to absorb realistic contention bursts
against the shared `_users.db`/`_spaces.db` singleton files under heavy concurrent load (many
parallel test-suite workers, or in production, many concurrent requests hitting the same
physical file) while still bounding worst-case latency rather than hanging indefinitely.
`tests/unit/db.test.js`'s busy_timeout assertions import and compare against the exported
`METADATA_DB_BUSY_TIMEOUT_MS` constant directly (not a hardcoded number), so they automatically
re-verify the new 30s value with no separate test edit required; re-ran that test to confirm
(`tests/unit/db.test.js` — 37/37 passed, both the full file and the busy_timeout test isolated
via `-t "busy_timeout"`).

Verified the Docker image itself (not just the source tree) actually carries the new value
before re-running the suite: `docker run --rm panino-api-test node -e "import('/app/backend/
api-service/db.js').then(m => console.log(m.METADATA_DB_BUSY_TIMEOUT_MS))"` printed `30000`.

Ran the canonical `npm run test:be` (Docker) **3 times** (rebuild + full run each time) after
the bump:
- **Run 1: 254/256** (2 failed). One failure was unrelated to busy_timeout —
  `tests/unit/db.test.js > ... should delete test database and WAL files`:
  `SqliteError: Safety level may not be changed inside a transaction` from `db.pragma("synchronous
  = normal")` in `getTestDb`, a different pre-existing cross-worker race (two workers'
  overlapping WAL-mode/synchronous-pragma calls against a database mid-transaction), not this
  session's change. The other was the same `SqliteError: database is locked` signature as
  before, from `addEditorMember`'s write transaction against the shared `_spaces.db` singleton —
  meaning that even a 30s busy_timeout is not an absolute guarantee under sufficiently adversarial
  container-level filesystem-lock contention with ~19 parallel test-file worker processes all
  sharing the same two physical metadata files (32 CPUs were available in-container, confirmed via
  `docker run ... node -e "os.cpus().length"`, so this is lock/I/O contention, not a CPU-count
  limitation).
- **Run 2: 256/256** (clean).
- **Run 3: 256/256** (clean).

Net: 2 of 3 canonical Docker runs were fully clean after the bump, versus the reported
deterministic failure at 5s; the residual flake is markedly rarer and, per its distinct
`addEditorMember`/`_spaces.db` signature, consistent with the same shared-singleton-file
contention pattern already identified in Follow-up 2 (not a new issue). One additional relevant
observation, **not acted on** because it is outside this narrow fix's scope: `vitest.config.js`
sets `testTimeout: 10000` (10s), which is shorter than the new 30s `busy_timeout` — for any
retry that would need between 10s and 30s to resolve, vitest's own test timeout would fire
first. This did not appear to be the proximate cause of either Run 1 failure (both surfaced as
`SqliteError`, not a "Test timed out" error, meaning SQLite's own busy handler exhausted its
window before vitest's timer did), but it is a latent mismatch worth flagging for whoever owns
CI configuration if this class of flake recurs.

Modified files added by this follow-up (on top of the sets listed above): none beyond
`backend/api-service/db.js` (constant value only) — `tests/unit/db.test.js` needed no edit since
it already asserts against the exported constant rather than a literal.

## Final Validation

- `npm run test:be` — **256/256 passed** in the canonical Docker/Node 24 runner after the final
  source change.
- `npm run lint` — passed.
- Focused Phase 2 tests (`spaces.test.js`, `db.test.js`, `revision.test.js`,
  `sync.spaces.test.js`, and `websocket.spaces.test.js`) — **106/106 passed**.
- `git diff --check` — passed.

## Open Items / Notes

- **Backup gap (Phase 6)**: shared spaces have no dedicated backup producer yet. `/sync`
  deliberately skips `triggerDailyAutoBackup` for space syncs rather than incorrectly folding
  space content into a member's personal GitHub backup. This means **shared-space content has
  no automated backup path at all** until Phase 6 defines one — an operational risk to flag
  explicitly to anyone enabling `SHARED_SPACES_ENABLED=true` before then.
  `docs/runbooks/sync-incident-response.md` and the production backup skill do not yet cover
  space content DBs; extend both when Phase 6 lands a producer.
  Additionally, the CR-SQLite backend the space DBs share with personal ones is `AGENTS.md`'s
  pinned/unmaintained 0.16.3 build, so any future SQLite bump is a sync-risk that also applies
  to spaces.
- **Untested-by-design paths**: `MAX_CONNECTIONS_PER_USER` (10) and the 4MiB backpressure close
  in `websocket.js` are implemented (per COLLAB-00 §4's "reasonable backpressure/connection
  limit if practical") but not exercised by any test this session — deliberately deprioritized
  behind the explicitly enumerated Task 6 scenarios given time constraints. A follow-up should
  add at least one test forcing `bufferedAmount` past 4MiB and one forcing an 11th connection
  for the same user, if these paths are considered load-bearing enough to warrant CI coverage.
- **Design choices not externally re-verified**: exact error-envelope field names (`ok`,
  `error.code`, `error.retryable`) and the decision to fold a malformed `dbKey` into the same
  `INVALID_SUBSCRIPTION`-style code family were made in a prior session against the spec docs'
  prose description (COLLAB-00 §4), not against an external reference test suite — they are,
  however, now locked in by the 20 passing `websocket.spaces.test.js` assertions, so any future
  change to these codes will be caught.
- Modified/created files
  (relative to `552f316`): `backend/api-service/{db.js,index.js,revision.js,spaces.js,sync.js,
  websocket.js,AGENTS.md}`, `backend/api-service/tests/unit/{db.test.js,spaces.test.js,
  revision.test.js}`, `backend/api-service/tests/integration/{sync.spaces.test.js,
  websocket.spaces.test.js}`, and this log. `git status --short` at the end of this session
  shows exactly those paths as modified/untracked; nothing under Phase 0's committed docs was
  touched.
- Public shared-space HTTP routes, frontend space registry/UI, space-scoped images/revisions
  routes, and invite/transfer/ownership lifecycle remain unimplemented by design (later
  phases) — `spaces.js` and `sync.js`/`websocket.js` are internal/trusted-caller-only surfaces
  with `SHARED_SPACES_ENABLED` defaulting to `false` everywhere.
