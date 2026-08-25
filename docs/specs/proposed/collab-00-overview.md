# COLLAB-00 — Collaboration: Overview & Sequencing

> Index for the collaboration spec set. Read this before picking up any individual COLLAB spec.
> Status: proposed
> Created: 2026-08-16
> Last updated: 2026-08-16 (final review)
> Source: architecture analysis of `sync.js`, `db.js`, `syncStore.js`, `Editor.vue`, 2026-08-16

---

## 1) Why this set exists

Panino replicates through CR-SQLite, which resolves conflicts **last-writer-wins per column**.
`notes.content` is a single TEXT column. Two people editing one document concurrently means one
person's entire body silently replaces the other's.

Investigating that turned up something more immediate: **the loss already happens today, for a
single user with two devices, and CR-SQLite is not even involved.** The editor's content watch is
keyed on document id, not content, so a remote edit never reaches an open editor and is destroyed
by the next local keystroke. See [COLLAB-01](collab-01-editor-conflict-safety.md).

So the set has two halves:

- **COLLAB-01 and COLLAB-02** fix single-user multi-device data loss. They have standalone value,
  ship independently of any collaboration feature, and are prerequisites for the rest.
- **COLLAB-03, COLLAB-04 and COLLAB-05** add collaboration proper: shared folder trees, and
  real-time co-editing of a document within an explicit session.

---

## 2) The specs

| # | Spec | Priority | Effort | Depends on |
|---|---|---|---|---|
| 01 | [Editor Conflict Safety](collab-01-editor-conflict-safety.md) | **P0** | ~2 days | — |
| 02 | [Content Merge](collab-02-content-merge.md) | P1 | ~1 week | 01 |
| 03 | [Identity Palette](collab-03-identity-palette.md) | P1 | ~1 day | — |
| 04 | [Shared Spaces](collab-04-shared-spaces.md) | P1 | multi-milestone | 02 (soft), 03 (soft) |
| 05 | [Live Sessions](collab-05-live-sessions.md) | P2 | estimate after spike | 02, 03, 04 |

The estimate for COLLAB-02 includes upgrade safety and convergence testing. COLLAB-04 is a
multi-milestone architecture change, not a three-week feature; it includes migration, transfer
recovery, security and operations work. COLLAB-05 may not be estimated until its textarea-binding
and crash-recovery spike passes its acceptance criteria.

---

## 3) Suggested sequence

```
COLLAB-01 ─────► COLLAB-02 ─────────────────┐
(stop clobbering) (merge instead of prompt)  │
                                             ├──► COLLAB-05
COLLAB-03 ──────────────────────────────────┤    (live sessions)
(identity palette)                           │
                                             │
COLLAB-04 ──────────────────────────────────┘
(shared spaces)
```

Four ordering constraints are real; the rest is preference:

1. **COLLAB-01 before everything.** It is an active bug, and it is also the permanent fallback
   path for any user who is offline or not in a session. Every later spec assumes it.
2. **COLLAB-02 before COLLAB-05.** A live session coordinates the people inside it. It does
   nothing about a non-participant who edited the same document offline, so the commit path needs
   a real merge. Without COLLAB-02, COLLAB-05's commit is just a clobber with better manners.
3. **COLLAB-03 before any collaboration UI.** It amends a documented, enforced design system.
   Doing it after the fact means retrofitting every presence surface.
4. **COLLAB-04 before COLLAB-05** in practice, not in principle. Sessions on personal documents
   are technically buildable, but "collaborate on a document only you can see" is not a product.

COLLAB-03 is independent and small enough to slot in anywhere before COLLAB-04.

---

## 4) Decisions already taken

These were settled during design. Recorded here so they are not relitigated inside the
individual specs.

### DECIDED: shared folders are separate databases, not filtered rows

CR-SQLite's replication unit is a whole database. Filtering rows out of a `/sync` response causes
**permanent, silent data loss**: the response's `clock` is `max(db_version)` over the entire
`crsql_changes` table ([sync.js:329-332](../../../backend/api-service/sync.js#L329-L332)), and the
client advances its cursor to it ([syncStore.js:72-77](../../../frontend/src/store/syncStore.js#L72-L77)),
so filtered rows are skipped forever. Tombstones make it worse — a delete arrives as `cid = '-1'`
with no base row, so the backend cannot determine which folder a deleted document belonged to
after the fact.

A shared folder tree therefore becomes its own CR-SQLite database, so authorization granularity
equals replication granularity. See [COLLAB-04](collab-04-shared-spaces.md).

The rejected alternative — keeping one database per user and relaying subtree changes between
them — requires a subtree classifier, a backend-local `note_id → space` index maintained on every
merge, per-database-pair relay cursors, and synthesized tombstones on revocation. That is a large
amount of novel clock-and-tombstone machinery in precisely the code that produced both 2026
production incidents (see [crsqlite-sync.md](../../architecture/crsqlite-sync.md)).

### DECIDED: the co-editing CRDT is session-scoped and not sync-replicated

The obvious CRDT design is an append-only CRR table of immutable ops (`note_ops`), replicated by
the existing `/sync`. It works — inserts never conflict, so LWW never fires — but it carries three
costs this project should not take on:

- **Op-log compaction.** The log grows without bound at keystroke rate, and compacting a
  distributed log needs a designated compactor and a snapshot protocol.
- **A CRDT runtime in the merge hot path.** The backend materializes `notes.content` from ops, so
  the CRDT library runs inside or adjacent to `applyChanges`
  ([sync.js:221-293](../../../backend/api-service/sync.js#L221-L293)). An exception there aborts
  the merge and risks the poisoned-sync-bit failure mode.
- **Binary payloads through a tolerant coercion path.** `toBufferLike`
  ([sync.js:23-62](../../../backend/api-service/sync.js#L23-L62)) guesses at string encodings —
  UUID, then hex, then base64, then UTF-8 fallback. Binary CRDT updates routed through that will
  silently corrupt on some inputs.

Scoping the CRDT to a live session and committing a plain text result deletes all three. The server
still durably snapshots acknowledged live-session state for crash recovery; this is a bounded,
server-local recovery record, not a replicated CRDT log.
`notes.content` stays LWW TEXT, so PDF, export, GitHub backup, revisions and search are untouched.
See [COLLAB-05](collab-05-live-sessions.md).

### DECIDED: no second realtime transport

A y-websocket service alongside CR-SQLite would give the best latency and the worst architecture —
two sources of truth for document content, two persistence stores, and an export/PDF/backup layer
that can read either. COLLAB-05 extends the **existing** WebSocket
([index.js:53-71](../../../backend/api-service/index.js#L53-L71)) with new message types instead.

### DECIDED: v1 shared spaces have owner and editor roles only

Complete local replication makes a genuine read-only role impossible without a separate pull-only
protocol or client-side discard semantics. Shipping a `viewer` role that appears editable locally
but cannot sync is misleading. COLLAB-04 therefore ships only `owner` and `editor`; read-only
sharing remains the server-rendered share-link alternative in §6 until a later, separately designed
protocol can enforce its UX contract.

### DECIDED: the server owns authorization and attribution

CR-SQLite `site_id` identifies a replica, not a verified person: incoming changes supply it and it
must not be presented as author identity. The authenticated request actor is recorded in
backend-only revision/audit metadata. A server-side collaborative save explicitly records its
committer. Replica-to-user bindings are diagnostic only and are immutable once established.

### DECIDED: one canonical content-merge module

The three-way merge implementation is the repository-local ESM package
`shared/contentMerge.js`, exported as `@panino/content-merge`. `shared/package.json` owns the single
`node-diff3` runtime dependency and its exact version. Both `frontend/package.json` and
`backend/api-service/package.json` declare that package through a `file:` dependency and import only
its package name; neither imports across the other application's source tree.

Because both Docker builds currently use a layer directory as their build context, the same change
must make the repository root their context, copy `shared/package*.json` before dependency
installation, and copy `shared/` into the image. Development bind mounts must expose the same source
without hiding either application's `node_modules`. Vite needs no source alias: it resolves the local
package from `frontend/node_modules`. Lockfiles for the shared package and both consumers change
together.

The package owns normalization, budgets, three-way merge, hunk serialization, hashing and test
vectors; frontend UI and backend session commit code are adapters around it. Tests live in
`shared/tests/contentMerge.test.js`, run by `npm test --prefix shared`; the root `npm test` runs
`test:shared` before frontend and backend tests. A duplicated implementation or copied build artifact
is not permitted.

### DECIDED: one versioned WebSocket envelope

Every text frame is JSON with the envelope
`{ "v": 1, "type": "<name>", "requestId"?: "<uuid>", "payload": { ... } }`. Client control
messages (`subscribe`, `unsubscribe`, `collab:open`, `collab:commit`, `collab:leave`) require a fresh
UUID `requestId`. Their terminal response echoes it as `ok` or `error`; asynchronous events omit it.
Errors use `{ code, message, retryable }`, where `code` is a stable machine-readable value and
`message` does not disclose a space the actor cannot access. Unknown versions/types receive
`UNSUPPORTED_PROTOCOL`/`UNKNOWN_MESSAGE` without mutating state.

After JWT connection authentication, a socket has no database subscriptions. It sends:

```json
{
  "v": 1,
  "type": "subscribe",
  "requestId": "<uuid>",
  "payload": {
    "databases": [
      { "dbKey": "user:<uuid>", "siteId": "<32-char lowercase hex>" },
      { "dbKey": "space:<uuid>", "siteId": "<32-char lowercase hex>" }
    ]
  }
}
```

The server validates the entire request before changing subscriptions. The operation is atomic:
one invalid, duplicate, unauthorized or over-limit entry rejects the whole request. Repeating an
identical successful request is idempotent. `unsubscribe` carries `{ dbKeys: [...] }`, is idempotent,
and immediately removes routing state. Reconnect starts empty; after refreshing the membership list,
the client resubscribes its personal database and each initialized space. A newly bootstrapped space
is subscribed only after its local `site_id` is known. `collab:open` requires an existing subscription
to the owning space but still re-authorizes membership and note access independently.

Removal, leaving, role loss, pending deletion, or token expiry immediately drops affected
subscriptions and sessions and emits `subscription:revoked` when the socket remains usable.
Membership version is checked on every authenticated space-list request and every sync cycle; the
server also pushes revocation to connected sockets. The client removes the database from its active
registry and clears queued outbound changes before another retry. Re-authentication remains mandatory
on every inbound message.

Control frames are limited to 64 KiB. A socket may subscribe to at most 101 databases (one personal
plus 100 spaces), and an account may belong to at most 100 spaces. The server rejects excess with
`SUBSCRIPTION_LIMIT`; it never silently truncates. If buffered outbound bytes exceed 1 MiB, the
server stops producing nonessential awareness events; at 4 MiB it closes with `1013` so the client
reconnects and catches up from durable clocks/state vectors. Oversized frames close with `1009`.
COLLAB-04 owns subscription payloads and sync pokes; COLLAB-05 adds session payloads within this
unchanged envelope.

### DECIDED: normalization and content hashes are shared contracts

`normalizeContent(value)` maps `null`/`undefined` to `""` and converts CRLF to LF. It performs no
Unicode normalization, whitespace trimming or trailing-newline rewriting. `contentHash(value)` is
lowercase hexadecimal SHA-256 over the UTF-8 bytes of `normalizeContent(value)`. Browser and Node
implementations must pass the same shared vectors. COLLAB-02 comparisons and COLLAB-05 commit
confirmation use these functions exclusively.

### DECIDED: feature gates fail closed and are server-controlled

The server owns `CONTENT_MERGE_WRITEBACK_ENABLED`, `SHARED_SPACES_ENABLED` and
`LIVE_SESSIONS_ENABLED`, all defaulting to `false` until their phase gate passes. Authenticated
capability responses and every `/sync` response include their current values. An absent or unknown
capability means disabled, preserving compatibility with an older server. The client may collect
merge bases while write-back is disabled, but may not automatically write a merge result unless the
same successful sync response advertises `contentMergeWriteback: true`. Disabling a flag stops new
admission immediately without deleting data or recovery state. Rollback procedures disable admission
first, drain or preserve durable work, then deploy compatible code; flags are never stored only in
`localStorage` or a build-time Vite variable.

### DECIDED: database schema is versioned by database kind

`initializeContentDb(db, kind)` applies ordered, idempotent migrations under a transaction and records
their integer version in a local `application_schema` table. Migrations declare whether they apply to
`user`, `space`, or both. Existing databases are upgraded before route/sync/session admission; failure
closes and invalidates that database connection rather than serving a partial schema. New databases
run the same migration sequence, not a separate snapshot-only path.

CRR schema remains identical in personal and space databases. Local non-CRR tables may intentionally
differ by kind and must say so in their owning spec. In particular, COLLAB-05 eagerly creates and
migrates `collab_sessions` in every space database when live sessions are deployed; it is never added
to a personal database or `CRR_TABLES`. The server raises `minimum_client_schema` only after the
compatible client is available and retains one previous schema version for rollback tests.

### DECIDED: collaboration resource limits

In addition to COLLAB-04's storage limits: at most 100 joined spaces per account, 10 authenticated
WebSocket connections per account, 20 participant connections and 20 distinct users per live
session, and 10 concurrent live sessions per space. Limits are configurable server constants with
stable error codes and metrics, but changing them does not alter protocol semantics. Identity colours
are deliberately not unique at the 20-person limit; initials, accessible names and the roster remain
the primary identity channels.

---

## 5) Explicit non-goals for the whole set

- **Operational-transform-grade latency.** Session edits converge in tens of milliseconds on a
  good connection; this is not a hard real-time guarantee.
- **Semantic conflict resolution.** A CRDT guarantees convergence, not intent. Two people
  rewriting the same paragraph differently produces a syntactically merged, semantically ruined
  paragraph on every replica. Presence UI mitigates this; nothing in this set solves it.
- **Offline co-editing.** COLLAB-05 sessions require connectivity by design. Offline editing
  continues to work exactly as today, with COLLAB-02 merge on reconnect.
- **Access control below folder granularity.** Sharing a single document without sharing a space
  is out of scope.
- **Read-only local replicas.** This set deliberately does not ship a viewer role. See the decision
  in §4; a future read-only protocol must define local editing, pull and revocation semantics.

---

## 6) A cheaper alternative, if the need is narrower

If the actual requirement is "let someone **read** my folder", a server-rendered read-only share
link — hashed expiring token in the auth database, backend reads the owner's database, renders
through the existing sanitize path — delivers that without touching sync, schema, or the frontend
database layer at all. It is perhaps two days of work against COLLAB-04's three weeks.

Confirm which problem is being solved before starting COLLAB-04.

---

## 7) Implementation handoff gates

Do not parallelize phases whose inputs are not yet stable. The implementation agent marks each gate
complete with the named automated/manual evidence before starting a dependent gate:

1. **Shared foundation:** create/install `@panino/content-merge`, update Docker/Compose contexts,
   pass shared Node plus frontend compatibility vectors.
2. **COLLAB-01:** land editor classification and write suppression; pass unit tests and the two-browser
   reproduction before enabling any merge behavior.
3. **COLLAB-03:** land palette primitives and design-system amendment; pass contrast, colour-distance
   and accessibility tests.
4. **COLLAB-02 stage 1:** migrate/populate local bases with server write-back capability false; prove
   import/export exclusion and old-server fail-closed behavior.
5. **COLLAB-02 stage 2:** enable write-back only after telemetry gate; pass two-device offline,
   rollback, oscillation and transaction-failure cases.
6. **COLLAB-04 Phase 0:** approve authorization matrix, `_spaces.db` invariants, transfer state
   diagram, migration/compatibility matrix and atomic backup/restore procedure.
7. **COLLAB-04 Phases 1–3:** land database-key refactor, schemas, allowlisted sync, versioned
   WebSocket subscription and frontend registry behind `SHARED_SPACES_ENABLED=false`; keep the full
   pre-space suites green.
8. **COLLAB-04 Phases 4–6:** land scoped stores, UI, lifecycle, images/revisions/transfers and
   operations metrics; pass revocation-while-online, quota, migration rollback and restore drills
   before enabling admission.
9. **COLLAB-05 mandatory spike:** prove textarea/Y.Text composition-selection-undo behavior and
   acknowledged/unacknowledged crash recovery. A failed spike stops estimation and implementation.
10. **COLLAB-05 implementation:** land space-only recovery migration, protocol, commit transaction,
    shutdown drain and UI behind `LIVE_SESSIONS_ENABLED=false`; pass forced-failure tests at every
    commit/shutdown boundary before enabling admission.
11. **Whole journey:** run §8 and retain command, browser and operations evidence in the required
    agent log.

Compatibility is tested at every wire/schema gate: old client/new server, new client/old server,
previous supported database/new code, capability disable/reenable and rollback to the retained
schema version. An implementation is not complete merely because two current clients pass the happy
path.

---

## 8) End-to-end validation exercise

Run this manual exercise against the complete development stack after COLLAB-01 through COLLAB-05
land. It is the acceptance test for the full journey, not a substitute for the unit and integration
tests in the individual specifications.

### Setup

Use Alice, Bob and Charlie as separate accounts and browsers. Open a second browser/device session
for Alice and keep it online through step 2 so it initializes the space replica; take it offline
before step 3. Prepare five uniquely searchable paragraph markers: `ALICE-ORIGINAL`, `ALICE-ADD`,
`BOB-ADD`, `CHARLIE-ADD` and `IMAGE-CAPTION`.

### Exercise

1. **Create private content.** Alice creates a personal document containing 100 words and
   `ALICE-ORIGINAL`, uploads one image, and adds `IMAGE-CAPTION` next to its markdown reference.
   Wait for her ordinary personal sync to complete.
2. **Create and populate a space.** Alice creates a space and invites Bob as an editor. After Bob
   accepts, Alice transfers the document into the space. Confirm the transfer shows progress, the
   space document retains all 100 words and its image renders from a space-qualified URL, and the
   source is deleted only after destination confirmation. Confirm Alice's second device initializes
   the new space replica, then take it offline. Confirm the personal revision history is reported as
   left behind.
3. **Bootstrap Bob and verify ordinary replication.** Bob opens the space and completes bootstrap.
   Confirm his local replica contains the same document, image and shared profile data without
   exposing Alice's email. Alice edits one new paragraph containing 50 words and `ALICE-ADD`; Bob
   receives the space WebSocket poke, pulls the CR-SQLite rows using his space clock, and sees the
   new paragraph and image without a reload.
4. **Exercise ordinary concurrent merge.** Disconnect Alice and Bob from the network. Alice adds
   25 words to one paragraph; Bob adds 25 words with `BOB-ADD` to a different paragraph. Reconnect
   them and wait for both sequential space syncs and any queued follow-up merge sync to finish.
   Confirm the document contains both edits, has 200 total words, and has no conflict marker or
   unresolved-conflict affordance. Repeat separately with both users changing the same line and
   confirm a recoverable conflict is presented instead of silently losing either body.
5. **Add Charlie.** Alice invites Charlie as an editor. Charlie accepts and bootstraps the space
   while Alice's second device remains offline. Confirm Charlie receives the complete 200-word body,
   the image bytes and metadata, but no personal revision history or member email addresses.
6. **Exercise live collaboration.** Alice, Bob and Charlie explicitly join a live session for the
   space document. Charlie adds 50 words containing `CHARLIE-ADD` while Alice and Bob observe the
   update through the live-session WebSocket within the collaboration latency target. Confirm every
   update is acknowledged only after durable recovery persistence. Charlie chooses **Save version**.
   Confirm the space database receives one ordinary CR-SQLite content change, one revision attributes
   the save to Charlie, and the document now contains all markers, the image, and 250 total words.
7. **Verify replica catch-up.** Alice's offline second device comes online after Charlie saves. It
   reconnects, sends its saved space clock and site id, receives the missing CR-SQLite changes, and
   applies them locally. Confirm it renders the 250-word body and image. The server must poke online
   Alice/Bob/Charlie replicas subscribed to that space, while any offline replica catches up from
   its clock on reconnect.
8. **Verify session/sync handoff and recovery.** While the session remains live after Charlie's
   save, confirm the matching CR-SQLite update advances the session base without overwriting the
   Yjs editor text or displaying a COLLAB-01/02 conflict. Then make an acknowledged live edit, stop
   the backend container, restart it, and confirm the session restores. Make one deliberately
   unacknowledged edit during a disconnect and confirm the client replays it after reconnect.

### Pass criteria

- Every authorized replica converges on the same 250-word document and one rendered image.
- Separate offline paragraph edits merge automatically; overlapping edits become visible,
  recoverable conflicts.
- The document is never absent during transfer; incomplete transfers remain resumable duplicates.
- Live edits converge before save; saved text reaches non-session and offline replicas through the
  normal CR-SQLite clock-based pull path.
- Revision attribution names the authenticated saving actor, never a CR-SQLite site id.
- No unauthorized account can sync, fetch the image, subscribe to the space, or infer its existence.
