# COLLAB-05 — Live Sessions

> Per-keystroke co-editing inside an explicit, online-only session that commits a plain text result.
> Status: proposed
> Created: 2026-08-16
> Last updated: 2026-08-16 (final review)
> Part of [COLLAB-00](collab-00-overview.md) · Depends on [COLLAB-02](collab-02-content-merge.md), [COLLAB-03](collab-03-identity-palette.md), [COLLAB-04](collab-04-shared-spaces.md)

---

## 1) Summary

A document in a space can be opened **for collaboration**. While a session is live, participants'
keystrokes flow through a CRDT held in backend memory with acknowledged, durable recovery snapshots
and converge in tens of milliseconds. The
session requires connectivity. Any editor participant can **commit**, which writes the agreed text into
the owning database as an ordinary `notes.content` update and replicates it to everyone through the
existing `/sync` path.

The CRDT is session-scoped and not sync-replicated. `notes.content` stays a plain LWW TEXT column.
The server keeps only bounded, session-local recovery state until a successful save or expiry; it is
not a CRDT table or a second document source of truth. See [COLLAB-00 §4](collab-00-overview.md).

What this design avoids, relative to replicating CRDT ops through CR-SQLite:

- no op-log compaction protocol
- no CRDT runtime inside or adjacent to the merge transaction
- no binary payloads through `toBufferLike`'s heuristic coercion
  ([sync.js:23-62](../../../backend/api-service/sync.js#L23-L62))
- no CRR schema change at all, so PDF, export, GitHub backup, revisions and search are untouched

What it costs: an online requirement while collaborating, a stateful backend component that must
survive deploys, and session lifecycle UX.

---

## 2) Goals

1. Two or more members of a space edit one document simultaneously with per-keystroke convergence.
2. Nobody's characters are lost to another participant.
3. A commit produces a normal document revision attributable to a person.
4. A commit that collides with a non-participant's offline edit is merged, not clobbered.
5. Losing connectivity is survivable, legible, and never silently destructive.

## Non-goals

- **No offline sessions.** Deliberate. Offline editing continues to work through
  [COLLAB-02](collab-02-content-merge.md).
- **No inline remote cursors in v1** (§7.3).
- **No semantic conflict resolution.** A CRDT converges; it does not protect meaning. Two people
  rewriting one paragraph produce identical nonsense on every replica.
- No sessions on personal documents in v1 — there is nobody to collaborate with.
- No voice, comments, or suggestions.

---

## 3) Session lifecycle

```
                  join (online, editor)
    ┌────────┐ ──────────────────────────► ┌──────┐
    │ closed │                             │ live │ ◄──┐
    └────────┘ ◄────────────────────────── └──────┘    │ reconnect
         ▲     grace period expires           │        │ (acknowledged ops replayed)
         │            (auto-commit)           │ socket drop
         │                                    ▼        │
         │                            ┌──────────────┐ │
         │                            │ reconnecting │ ─┘
         │                            └──────────────┘
         │                                    │ timeout (~30s)
         │        session ended               ▼
         └──────────────────────────  ┌───────────┐
                                      │ read-only │
                                      └───────────┘
```

**Entering is explicit.** Opening a document never starts a session by itself. Panino's mental
model is private local documents; having someone silently watching you type because they had the
same document open would be a genuine violation of that. A user presses **Collaborate**; other
members of the space are notified and may join.

**Reconnecting** is not **read-only**. A brief network blip buffers unacknowledged ops locally and
replays them by sequence number after a state-vector exchange; a server acknowledgement means the
update is durable in recovery storage, not merely echoed. The last participant leaving starts a
30-second reconnect grace period before auto-save. Past a hard timeout the client drops to
read-only, keeps the unsent text retrievable, and stops pretending.

There is no host role: the session survives any individual participant leaving. A disconnected
participant remains in the reconnecting roster for at most 30 seconds, then expires; awareness
expires after 15 seconds without an update and displays as idle before removal. Socket close removes
ephemeral awareness immediately but not the participant's durable acknowledgement cursor. Limits
from COLLAB-00 apply: 20 participant connections, 20 distinct users per session, 10 sessions per
space and 10 sockets per account. Admission beyond a limit fails with `SESSION_LIMIT`; an existing
session is never evicted to make room.

---

## 4) Protocol

Extends the existing WebSocket and uses the exact versioned envelope, request/response, subscription,
authorization, size and backpressure rules in [COLLAB-00 §4](collab-00-overview.md). The table below
describes each envelope's `payload`, not a second top-level format. Note that `ws.on('message')`
**does not exist today** — the socket
is outbound-poke-only ([index.js:53-71](../../../backend/api-service/index.js#L53-L71)) — and
[COLLAB-04 §4.3](collab-04-shared-spaces.md) introduces it.

| Message | Direction | Payload | Notes |
|---|---|---|---|
| `collab:open` | C→S | `{ space, noteId }` | Starts or joins. Authorized per message. |
| `collab:state` | S→C | `{ sessionId, stateVector, update, participants, ack }` | Full CRDT state and durable sequence |
| `collab:update` | C→S | `{ sessionId, seq, update }` | Base64 Yjs update; ordered per participant |
| `collab:update` | S→C | `{ sessionId, from, seq, update }` | Re-broadcast only after durable persistence |
| `collab:ack` | S→C | `{ sessionId, seq }` | Sender may discard updates through `seq` |
| `collab:awareness` | C↔S | `{ sessionId, cursor?, selection?, idle }` | Ephemeral, never persisted |
| `collab:commit` | C→S | `{ sessionId }` | Any editor participant; the server owns the merge base |
| `collab:committed` | S→C | `{ sessionId, by, at, result, contentHash? }` | `result`: `applied` \| `merged` \| `conflict`; hash is present only after a durable save |
| `collab:leave` | C→S | `{ sessionId }` | |
| `collab:participants` | S→C | `{ sessionId, participants }` | Roster changes |
| `collab:closed` | S→C | `{ sessionId, reason }` | `committed` \| `idle` \| `shutdown` \| `revoked` |

**Every inbound message re-authorizes** the `space`/`noteId` against `req.user.user_id` and an
editor membership. A socket that authenticated at connect time is not licensed to join any session
it names. `collab:open` additionally requires an active subscription to the space database.
Membership revoked mid-session closes the socket's sessions immediately.

Updates are transported as **base64 text**, not binary frames — consistent with
[COLLAB-00 §4](collab-00-overview.md)'s reasoning about not letting CRDT bytes near loose
coercion, and it keeps the message envelope uniformly JSON.

The server accepts a maximum 256 KiB decoded update and 1 MiB message, limits updates to 40 per
participant per second, rejects invalid base64/Yjs updates without mutating the session, and closes
repeat offenders. Duplicate `(sessionId, participant, seq)` updates are acknowledged but applied
once. On reconnect, client and server exchange state vectors before replaying unacknowledged updates.
Awareness is capped at 10 messages/second and never admitted to recovery storage.

`LIVE_SESSIONS_ENABLED` is checked on every `collab:open`. Disabled means
`FEATURE_DISABLED` for new joins while existing sessions enter the ordinary save-and-drain path;
recovery rows are never deleted merely because the flag is off.

---

## 5) Backend

### 5.1 Session manager

New module `backend/api-service/collab.js`. Holds a `Map` keyed by `${dbKey}:${noteId}` of:

```js
{ sessionId, ydoc, participants: Map<ws, {userId, joinedAt, highestAck}>,
 baseContent, baseHash, lastActivityAt, durableSequence, commitState }
```

`ydoc` is a `Y.Doc` with a single `Y.Text` named `content`, seeded from `notes.content` at session
start. `baseContent` is that seed value — it is what the commit-time merge uses as its base.
`baseHash` is `contentHash(baseContent)` from `@panino/content-merge`; it is server-owned diagnostic
state, not a client concurrency token.

The service runs as a single container with no replicas
([docker-compose.yml](../../../docker-compose.yml)), so in-memory is viable. If that ever changes,
this design needs revisiting before the second replica starts.

### 5.2 Durability — the part that will hurt if skipped

The backend is `restart: always` and [deploy.sh](../../../deploy.sh) rebuilds and restarts
containers on every release. **In-memory sessions vanish on every deploy**, silently destroying
however much collaborative work had not been committed. Shipping a release at 3pm would delete
work in progress with no trace.

Two mechanisms, both required, both in the same change as the in-memory manager — not as a
follow-up:

1. **Acknowledged durable snapshot.** Before sending `collab:ack` or rebroadcasting an update, fold
   the accepted update into the encoded Yjs document state and persist that state in a local,
   non-CRR table in the owning database. Coalesce a 50ms batch only when every update in it receives
   an acknowledgement after the same transaction commits. Therefore the recovery point objective
   for **acknowledged** edits is zero; an unacknowledged edit remains in the client replay buffer.

   ```sql
   CREATE TABLE IF NOT EXISTS collab_sessions (
     note_id     TEXT PRIMARY KEY NOT NULL,
     session_id  TEXT NOT NULL UNIQUE,
     ydoc_state  BLOB NOT NULL,
     base_content TEXT NOT NULL,
     base_hash   TEXT NOT NULL,
     durable_sequence INTEGER NOT NULL DEFAULT 0,
     started_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   );
   ```

   Not a CRR. Never added to `CRR_TABLES` or the shared CRR `BASE_SCHEMA`. The COLLAB-05 ordered
   `space` migration in `initializeContentDb` eagerly creates/upgrades it in every existing and new
   space database before `LIVE_SESSIONS_ENABLED` can admit a session. Personal databases never
   receive it. Migration failure invalidates that space connection and admits no session. A plain
   `BLOB` is safe **precisely because** it never travels through `/sync`.

2. **Graceful shutdown.** Configure Docker `stop_grace_period: 15s`; the `SIGTERM` handler has a
   12-second deadline. It first stops HTTP/WebSocket admission and marks every session shutting down,
   then waits for each in-flight commit lock and accepted 50ms durability batch to finish. SQLite
   statements are allowed to complete atomically; a commit is never snapshotted halfway through.
   Once a lock is held and its batch drained, snapshot that session, release the lock, and broadcast
   `collab:closed` with `reason: "shutdown"` only after the write commits. If the deadline expires,
   terminate without a success-shaped close event; the last committed recovery snapshot remains and
   clients replay every unacknowledged update after restart. Tests force termination at each commit
   step and prove the restored state is either wholly pre-commit or wholly post-commit.

On startup, any `collab_sessions` row is a recoverable session: restore it when an editor next
opens the document, authenticate them again, and send its durable sequence/state vector. A note,
space, or membership deletion removes/revokes its session rows before the destructive action
completes.

### 5.3 Commit

1. Authorize the caller as an editor participant and acquire the per-session commit lock.
2. Tell all participants `collab:committing`, stop accepting updates after a sequence barrier, flush
   all accepted updates durably, and require clients to resend/replay anything not acknowledged.
3. Take the now-stable `Y.Text` string as `mine`.
4. Read `notes.content` as `theirs` and compare against the session's `baseContent`.
   - unchanged → apply directly, `result: applied`
   - changed → a non-participant edited it during the session. Run the **same three-way merge as
     [COLLAB-02](collab-02-content-merge.md)** with `base = baseContent`. Clean → apply,
     `result: merged`. Conflicted → do not apply; return `result: conflict` with the hunks and let a
     human resolve in-session.
5. In one database transaction, apply a parameterized
   `UPDATE notes SET content = ?, updated_at = ?` and explicitly call the revision service to create
   exactly one snapshot with `actor_user_id = req.user.user_id` and `actor_kind = "collab"`. A local
   server `UPDATE` does not pass through `extractNoteMutations`, so merely relying on the sync route
   would create no revision. Extract/reuse `createRevisionSnapshot` rather than duplicating revision
   SQL. Failure of either the content write or revision insert rolls back both. The content write
   produces an ordinary CRR change that replicates through `/sync` with no new wire format.
6. Record the committer only through backend revision actor metadata
   ([COLLAB-04 §3.3](collab-04-shared-spaces.md)); no client field or site id can override it.
7. Reset `baseContent`, `baseHash` and recovery state atomically; then release the commit lock
   and resume updates. On an error, release the lock and restore live editing without changing
   `notes.content`.
8. Poke every other client of the owning database, as today
   ([sync.js:296-312](../../../backend/api-service/sync.js#L296-L312)).

Import the canonical `@panino/content-merge` local package defined by
[COLLAB-00 §4](collab-00-overview.md). The backend Docker/package changes required to install the
same package land before `collab.js`; neither layer may carry its own merge implementation.

**Auto-save** on: reconnect grace expiry after the last participant leaves; 10 minutes without a
document update; and graceful shutdown. Awareness alone does not reset document inactivity. A failed auto-save retains durable session recovery
state and reports a recoverable error rather than discarding work. After a successful save, delete
the recovery row. A maintenance job deletes an abandoned row only after 30 days, preserving the
latest Yjs state in a compressed support export first; enforce a 50 MiB recovery-state cap per
space and reject new session updates with a recoverable “save or close a session” error at the cap.

### 5.4 Not in the merge path

Nothing in `collab.js` runs inside `applyChanges`
([sync.js:221-293](../../../backend/api-service/sync.js#L221-L293)). Commits go through an ordinary
`UPDATE` on a healthy connection obtained via `getHealthyDb(dbKey)`. A CRDT exception must never be
able to abort a CRR merge transaction — that is the poisoned-sync-bit failure mode described in
[crsqlite-sync.md](../../architecture/crsqlite-sync.md), and it is the single most expensive
mistake available in this codebase.

---

## 6) Frontend

### 6.1 CRDT choice

**Yjs.** Pure JavaScript, so the same library runs in the browser and in the Node backend with no
native binding and no ABI concern — which matters in a repository where `better-sqlite3`'s ABI has
blocked the test suite repeatedly. Loro and Automerge are WASM/native and would reintroduce exactly
that class of problem on the backend.

### 6.1a Mandatory implementation spike

Before the session manager or UI is scheduled, implement a disposable, tested spike that binds two
OverType textareas to one `Y.Text` and exercises insert, replace, paste, composition, selection
transformation and origin-scoped undo. In parallel, crash the server after a durable acknowledgement
and verify restoration plus replay of an unacknowledged local update. The feature may proceed only
if both cases pass without a full-document overwrite; otherwise replace the editor binding approach
or narrow the product before estimating COLLAB-05.

### 6.2 Editor binding

OverType is a `textarea` layered over an aligned preview div. The Yjs ecosystem binds CodeMirror,
ProseMirror, Quill and Monaco — **not a plain textarea**. The binding is written here:

- On input, diff previous versus current textarea value with a common-prefix/common-suffix scan and
  emit a single `delete`+`insert` on the `Y.Text`.
- On remote update, apply to the textarea and transform the local selection by the incoming delta
  so the caret does not jump.
- Batch browser-generated Yjs ops on a dedicated 50ms **network-send** timer, independent from both
  the existing 500ms database save debounce and the server's 50ms **durable-snapshot** coalescing
  timer. The equal values are coincidental; the timers have different owners and never acknowledge
  one another. This delivers bounded low-latency collaboration without claiming a message per
  physical keystroke.
- IME composition: suspend diffing between `compositionstart` and `compositionend`. Emitting ops
  mid-composition corrupts input in every CJK keyboard.
- Paste of a large block is one op, not a character sequence.

### 6.3 Undo must be replaced

[historyStore.js](../../../frontend/src/store/historyStore.js) keeps a per-document stack of **full
text snapshots** and restores them wholesale via `setValue`
([Editor.vue:245-270](../../../frontend/src/components/Editor.vue#L245-L270)). In a live session
that is a "delete everything, insert my version" operation — it would destroy a collaborator's
concurrent edits on every undo.

In session mode, every local Yjs transaction uses a unique, stable local origin object and
undo/redo route to `Y.UndoManager` scoped to that origin, so a user undoes only their own edits.
The `isHistoryAction` guard plumbing and the Ctrl+Z/Ctrl+Y trap in
`handleKeydown` ([Editor.vue:182-199](../../../frontend/src/components/Editor.vue#L182-L199)) switch
implementation based on session state. `historyStore` remains the non-session implementation and is
not deleted.

### 6.4 Interaction with COLLAB-01/02

While a session is live, the local `updateFileContent` debounce is **suspended entirely** — the
session owns the content. COLLAB-01's conflict banner does not apply, because the session's commit
path handles divergence. A normal CR-SQLite content update received while the session is live
(including another participant's save) updates only the session's `baseContent` when its normalized
content hashes to a recently received `contentHash` in `collab:committed` for this `sessionId`.
Both sides call the shared `normalizeContent` and lowercase UTF-8 SHA-256 `contentHash` functions
defined in COLLAB-00. The server sends `collab:committed` before the owning database's sync poke.
The client retains the last 16 committed hashes for five minutes and defers classifying an
in-session CR-SQLite content change until the current sync response and already-ordered WebSocket
events have been processed; then it consumes one matching hash.
It must not call `setValue`, create a COLLAB-01/02 conflict, or replace the Yjs text. A CR-SQLite
update without that matching hash is a non-participant edit and remains pending for the next save's
three-way merge. On session end, fetch the final persisted body, set the editor/draft/base from that
body, then resume ordinary saving.

---

## 7) UI

### 7.1 States

The editor must express five states legibly, in one place. Today it expresses two — and one of
those, `docStore.isSaving`, is rendered nowhere at all
([COLLAB-01 §2](collab-01-editor-conflict-safety.md)).

| State | Indicator | Editing |
|---|---|---|
| Solo, offline | existing offline banner | yes, local |
| Solo, online | save status (from COLLAB-01) | yes |
| Live session | participant stack + "n unsaved changes" | yes |
| Reconnecting | amber pill, "Reconnecting…" | yes, buffering |
| Dropped | `pn-alert-warning`, reason + recovery | **no** |

**One connection source of truth.** [OfflineIndicator.vue](../../../frontend/src/components/OfflineIndicator.vue)
keeps its own `navigator.onLine` ref instead of reading `syncStore.isOnline` — two sources that can
already disagree. Consolidate before adding session state as a third consumer, or users will see a
"you're offline" banner and a "session live" pill simultaneously.

**Read-only must look read-only.** Silently swallowing keystrokes is the worst available failure.
Dim the surface, state the reason, and keep the unsent text copyable. Use the design system's
`opacity-50` + `cursor-not-allowed` disabled convention
([ui-design-system.md §1](../../architecture/ui-design-system.md)).

### 7.2 Naming

"Commit" is developer language and [AGENTS.md §4](../../../AGENTS.md) reserves technical terms for
technical things. Pick a product word before it reaches twenty strings — **Save version** is the
recommendation; "Publish" implies an audience beyond the space.

### 7.3 Deliberately deferred: inline remote cursors

Placing another user's caret inside a `textarea` is impossible; it requires absolutely-positioned
markers measured against OverType's preview layer and kept aligned through wrapping, scrolling and
theme changes. It is the most recognisable collaboration affordance and by far the worst
effort-to-value ratio here.

v1 ships a participant roster (`AvatarStack` from
[COLLAB-03](collab-03-identity-palette.md)) plus a per-participant "editing" indicator. That is most
of the value for a fraction of the work, and it can be upgraded later without protocol changes —
`collab:awareness` already carries cursor positions.

### 7.4 Other surfaces

- Someone else committing while you type is a **toast** (`uiStore.addToast`), never a modal — it
  must not steal focus or the caret.
- A commit dialog uses `BaseModal` with `:close-on-backdrop="false"`.
- Commit-conflict resolution reuses the hunk UI from
  [COLLAB-02 §6.2](collab-02-content-merge.md).
- Mobile: a roster, a status pill and a commit action competing in a viewport that already carries
  [MobileMenu.vue](../../../frontend/src/components/MobileMenu.vue) and a resizable sidebar. Sketch
  this before committing to a desktop layout.
- Test ids throughout: `collab-status`, `collab-participants`, `collab-commit`,
  `collab-readonly-notice`.

---

## 8) Tests

Backend (`npm run test:be`):

- `unit/collab.test.js` — session create/join/leave; auto-commit on last leave; idle auto-commit;
  durable acknowledgement; duplicate sequence handling; restore from `collab_sessions`; `SIGTERM`
  waits for commit locks and flushes every live session or truthfully reports an unflushed buffer;
  space-only eager migration and migration failure
- `integration/collab.test.js` — two sockets converge on interleaved updates; non-member
  `collab:open` rejected; malformed/oversized/rate-limited updates rejected; membership revoked
  mid-session closes the session; reconnect state-vector replay converges; commit serializes an
  update barrier; commit with an unchanged base applies; commit with a changed base merges; commit
  with a conflicting base returns hunks and does **not** write; participant/session/socket limits;
  feature-disable drains existing sessions but rejects new admission; forced shutdown at every
  commit step restores wholly pre-commit or post-commit state
- `integration/sync.test.js` — extend: a commit produces exactly one CRR content change and one
  revision, attributed to the committer; an in-session CR-SQLite commit refreshes session base
  without replacing editor text or raising a conflict
- Assert explicitly that a thrown CRDT error never reaches `applyChanges`

Frontend (`frontend/tests/unit/`):

- `yTextareaBinding.test.js` — insert, delete, replace, paste; selection preserved under a remote
  insert before the caret; IME composition emits nothing until `compositionend`
- `collabSession.test.js` — state machine transitions; reconnect replays only unacknowledged ops;
  timeout drops to read-only and blocks input; session-owned sync handoff does not trigger
  COLLAB-01/02; normalized hash matching works across CRLF/LF and rejects a different body; session
  end restores normal saving and base tracking
- `collabUndo.test.js` — undo in session mode affects only local-origin edits

Manual: two accounts, one document, concurrent typing; then **kill the backend container after an
acknowledged update and confirm it restores**; repeat during a deliberately unacknowledged update
and confirm the client replays it. These cases belong in the runbook, not just the spec.

---

## 9) Risks

- **Deploy-time data loss.** §5.2 is not optional. If an acknowledgement precedes durable recovery
  persistence, the feature ships with a scheduled data-loss bug.
- **The textarea binding is the schedule risk.** IME, paste, undo interaction and selection
  transformation are each individually fiddly. Budget for it explicitly rather than treating it as
  glue.
- **Two merge implementations drifting apart.** §5.3. Share the code or share the test vectors.
- **Session state confusion.** Five states is near the limit of what one indicator can carry.
  Prototype the indicator before building the protocol; if it cannot be made legible, reduce the
  states rather than adding indicators.
- **Awareness message volume.** Cursor updates at keystroke rate across *n* participants is *n²*
  messages. Throttle awareness to ~10/s and never persist it.
