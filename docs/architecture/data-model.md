# Data model and sync contract

## Database classes

The browser has the synced content tables and the backend has the same CRR schema plus
backend-only operational tables. The backend also has a separate authentication database.

### Per-user database

| Table | Classification | Purpose |
|---|---|---|
| `users` | CRR | User profile replicated to clients |
| `folders` | CRR | Folder tree |
| `notes` | CRR | Markdown documents, including the `pinned` flag surfaced by the document dashboards |
| `images` | CRR | Uploaded-image metadata |
| `settings` | CRR | JSON-encoded user settings |
| `globals` | CRR | Global template variables |
| `templates` | CRR | Document templates |
| `backup_config` | Local/backend-only | Provider credentials and backup state |
| `note_revisions` | Local/backend-only | Compressed revision snapshots |
| `note_revision_meta` | Local/backend-only | Revision pruning metadata |

The backend schema is declared in `backend/api-service/db.js`; the browser schema is declared
in `frontend/src/store/syncStore.js`. Keep those two schema definitions aligned for every CRR
table. Backend-only `application_schema`, `_spaces.db` tables, revision tables, and personal backup
configuration are deliberate non-CRR exceptions.

### Shared-space content databases

Shared spaces use `data/spaces/{spaceId}.db` and the same CRR content tables as personal databases. Backend content connections use canonical `space:<uuid>` keys; personal databases use `user:<uuid>`. `application_schema` is a local, non-CRR table that records the content database kind and ordered schema version. Personal-only `backup_config` is not created in a space database.

Content schema v2 adds `collab_sessions`, `collab_session_acks`, and
`collab_recovery_archives` only to space databases. All are backend-local, non-CRR recovery
tables. The first stores the last acknowledged Yjs document state and server-owned plain-text
merge base; the second makes participant sequence acknowledgements idempotent across a restart;
the third retains the gzip support export made before 30-day abandoned-state deletion. None is
part of `/sync` or the browser schema, and `notes.content` remains the only replicated document
body.

### Shared-space metadata database

`data/_spaces.db` is backend-only and not synced. It contains `spaces`, `space_members`,
`space_invites`, `space_user_versions`, `space_transfers`, and its own ordered
`spaces_schema_migrations` table.
Schema v2 adds a non-secret UUID management id and revocation timestamp to invitations; raw
256-bit invite tokens appear only in email or the owner's immediate create/resend response, while
SHA-256 hashes remain at rest. Invites are normalized to the captured email, expire after seven
days, create editors only, and are single-use. `GET /space-invitations` lists only active,
unexpired invitations matching the authenticated account email and never returns a token.
`POST /space-invitations/:inviteId/accept` re-checks that email and invitation state before adding
membership; the token-based email landing route remains supported.

Schema v3 adds server-owned cross-database transfer checkpoints. A transfer records the actor,
source/destination database keys and Document ids, source content hash/timestamp, stable image-id
map, visible warnings, stage, and confirmation/deletion timestamps. The API reauthorizes both
databases on every resume/recovery action. Destination rows and copied bytes are hash/size verified
before source deletion; terminal recovery is either `complete` or `kept_both`.

All lifecycle routes fail closed unless `SHARED_SPACES_ENABLED=true`. The authenticated,
paginated `GET /spaces` registry returns only active memberships, a membership version, the
minimum supported client schema, and profile-safe member `{id, name}` values. Member-detail
responses expose pending invite email only to the owner. Rename, member changes, ownership
transfer, leave, and deletion advance every affected member's version. Removal/leave/deletion
also revoke active WebSocket subscriptions immediately. A deletion request makes the space
inaccessible at once, retains its content/uploads for 30 days, and leaves feature-flag-independent
maintenance to purge the retained set after the deadline.

Space image metadata remains in the space content database while bytes live under
`uploads/spaces/{spaceId}/`. Every image operation, including token-query `<img>` reads and PDF
embedding, resolves active membership first; qualified HTTP responses use `private, no-store`.
Canonical Markdown destinations are `/images/{id}?space={spaceId}`. Revision routes use the same
optional `space` qualifier and return only backend-derived actor `{id, name}` display data.

### Authentication database

`data/_users.db` is not synced. It contains:

```sql
users (id TEXT PRIMARY KEY, name, email, password_hash, created_at)
password_resets (token_hash TEXT PRIMARY KEY, user_id, expires_at)
```

The `users` table in this database is separate from the per-user CRR `users` table.

## Settings

The synced `settings` table stores one JSON string per setting key. Current keys include
`previewStyles`, `printStyles`, and `uiSettings`.

## `/sync` wire contract

```text
POST /sync
Body:     { since: number, siteId: hex_string, changes: Change[], space?: uuid }
Response: { changes: Change[], clock: number, skipped: number, membershipVersion?: number }
```

Each change has the shape:

```text
{ table, pk, cid, val, col_version, db_version, site_id, cl, seq }
```

- `pk` is commonly a JSON array string such as `'["uuid-value"]'`.
- `site_id` is a 32-character hexadecimal representation of 16 bytes.
- `val` is a JSON-encoded scalar for values received from the browser.
- `clock` is the highest `db_version` returned by the backend.
- An absent `space` targets the authenticated user's personal database; a present `space`
  targets canonical `space:<uuid>` state after membership authorization. A non-member receives
  the same `404` shape as a missing space.
- Space responses carry `membershipVersion`; clients refresh their paginated membership snapshot
  before retrying when it changes.
- `skipped` is an observability field for the number of changes rejected by legacy
  per-change handling; new code should fail closed rather than silently treating a failed
  merge as success.

## Conversion helpers

`backend/api-service/sync.js` contains the boundary normalizers:

- `toBufferLike(v)` converts hex, arrays, UUID strings, base64, and numeric-key objects to a
  buffer where possible.
- `toSiteIdBlob(v)` converts a site ID to a 16-byte buffer.
- `toSqliteScalar(v)` converts JSON values to SQLite-bindable scalar values.

Use parameterized SQL for all application values. Do not interpolate primary keys, user IDs,
or change values into SQL text.

## Browser database registry

The frontend registry is keyed only by canonical `user:<uuid>` and `space:<uuid>` values. Each
entry owns its CR-SQLite handle, database-reported site ID, clock, and sync/apply state. Browser
clocks live at `crsqlite_clock:<dbKey>`; initialization migrates and removes the legacy personal
`crsqlite_clock` key once. The personal database opens before asynchronous membership discovery,
and registered databases sync sequentially so a failed replica cannot block or advance another.

Frontend repositories require a database key at their public boundary. Tree nodes retain an
in-memory node-to-database index, dashboard rows are tagged before their per-database result sets
are merged, and global limits are applied only after that merge. A revoked membership closes and
removes the local handle from the active registry and unsubscribes its WebSocket key.
