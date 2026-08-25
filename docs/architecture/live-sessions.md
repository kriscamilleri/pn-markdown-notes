# Live collaboration sessions

Live sessions are an explicit, online-only editing mode for Documents in shared spaces. They are
disabled unless `LIVE_SESSIONS_ENABLED=true`; shared spaces remain independently disabled by
default through `SHARED_SPACES_ENABLED=false`.

## Source of truth

Each active `(space, Document)` pair has one backend `Y.Doc` containing one `Y.Text` named
`content`. Yjs exists only for the lifetime and crash recovery of that session. A user action named
**Save version** writes plain text to the ordinary `notes.content` CRR column and creates exactly
one backend-attributed revision with `actor_kind = 'collab'`. Existing `/sync`, export, PDF,
search, backup, and revision readers therefore continue to consume plain text.

The server owns the session's initial `baseContent`. If the persisted Document changed outside the
session, saving uses the canonical `@panino/content-merge` three-way merge. A clean merge is saved;
an overlap returns complete server-owned base/mine/theirs bodies and conflict hunks to the existing
resolution UI without changing `notes.content`.

## Authorization and protocol

Live messages use the version-1 JSON WebSocket envelope and base64 Yjs updates. Opening requires an
active subscription to `space:<uuid>`, an active owner/editor membership, an existing Document, and
the live-session feature flag. Every update, awareness, save, and participant lookup rechecks the
authenticated account and current membership. Missing spaces, missing Documents, nonmembers, and
deleted accounts receive the same non-disclosing not-found outcome.

Limits are enforced at admission and message boundaries: 20 connections and 20 distinct users per
session, 10 sessions per space, 10 account sockets, 256 KiB decoded updates, 1 MiB messages, 40
updates/second, and 10 awareness messages/second. Membership removal closes that participant
immediately; a deletion request closes all sessions for the space and removes their recovery rows.

## Durable acknowledgement

Space content schema v2 eagerly creates two local tables before admission:

- `collab_sessions` stores the encoded full Yjs state, merge base/hash, global durable sequence,
  and timestamps.
- `collab_session_acks` stores the highest accepted sequence per stable socket site ID.

An accepted update is applied, the full state and participant cursor are committed in one SQLite
transaction, and only then is it acknowledged and rebroadcast. A client retains unacknowledged
updates, exchanges full state after reconnect, and replays only sequences above the durable cursor.
Yjs plus the durable cursor makes replay idempotent.

The last participant starts a 30-second reconnect grace period. Document activity, not awareness,
resets the 10-minute idle-save timer. Grace expiry, idle expiry, and graceful shutdown attempt an
ordinary save; a merge conflict or failure retains the recovery row. `SIGTERM` stops admission and
has a 12-second flush deadline under Docker's 15-second stop grace. Success-shaped shutdown closes
are emitted only after durable completion.

Abandoned recovery older than 30 days is gzip-archived into the backend-only
`collab_recovery_archives` table before deletion. Live recovery state is capped at 50 MiB per
space. The archive rows live in the space database and are therefore covered by production backup.

## Browser ownership

The normal draft/database debounce and COLLAB-01/02 conflict classification are suspended while a
session owns the open Document. A textarea binding converts each browser edit to one contiguous
Yjs delete/insert, pauses during IME composition, transforms selections for remote deltas, and uses
an origin-scoped `Y.UndoManager`. On session end the client syncs and refreshes the persisted plain
text before ordinary saving resumes. The UI exposes solo, joining/live, reconnecting, saving, and
dropped/read-only states in one status strip.
