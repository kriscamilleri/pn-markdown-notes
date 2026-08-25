# COLLAB-04 — Shared Spaces

> A shared folder tree is its own CR-SQLite database, replicated in full to every member.
> Status: proposed
> Created: 2026-08-16
> Last updated: 2026-08-20
> Part of [COLLAB-00](collab-00-overview.md) · Soft-depends on [COLLAB-02](collab-02-content-merge.md), [COLLAB-03](collab-03-identity-palette.md)

---

## 1) Summary

Introduce a **space**: a named, shareable document tree backed by its own CR-SQLite database,
`data/spaces/<spaceId>.db`, with the same CRR content schema and CRR set as a personal database plus
explicit space-only local tables. Members hold a complete local replica alongside their personal
one, so a shared document is fully editable offline exactly like a private one.

This is the largest spec in the set and it touches every layer. The single biggest piece of work is
the frontend, which currently assumes exactly one database everywhere.

Why a separate database rather than filtered rows is settled in
[COLLAB-00 §4](collab-00-overview.md) — briefly, filtering rows out of a `/sync` response causes
permanent silent data loss because the client advances its cursor past them.

---

## 2) Goals

1. A user can create a space, invite others by email, and assign a role.
2. A space appears in the sidebar as a root node containing folders and documents.
3. Members edit space documents offline; changes replicate through the existing `/sync` path.
4. Documents can move between a personal tree and a space, deliberately and visibly.
5. Images, revisions and PDF export work for space documents.
6. A signed-in user can discover and explicitly accept invitations addressed to their account from
   Manage Spaces, without needing to recover the original email.

### 2.1 User journeys

| # | Persona | Journey | Acceptance criteria |
|---|---|---|---|
| U1 | Invited editor | Opens Manage Spaces, reviews an invitation, and selects **Accept** | Only active, unexpired invitations matching the authenticated account email appear; acceptance adds the space and removes the invitation from the list |
| U2 | Wrong account | Opens Manage Spaces or attempts to accept another account's invitation | The invitation is not listed and acceptance returns the same neutral invalid-invitation response without adding membership |
| U3 | Email-link recipient | Opens the tokenized email link and explicitly accepts | Visiting does not auto-accept; the existing hashed, single-use token flow remains supported |

## Non-goals

- No realtime co-editing — that is [COLLAB-05](collab-05-live-sessions.md). Concurrent edits here
  resolve by LWW, softened by [COLLAB-02](collab-02-content-merge.md).
- No per-document permissions. The space is the unit.
- No nested or shared-into-shared spaces.
- No GitHub backup of spaces in v1 (§6.6).
- No read-only local replica in v1. V1 has owner and editor roles only; see
  [COLLAB-00 §4](collab-00-overview.md).

---

## 3) Data model

### 3.1 Space databases

A space database uses the same CRR content schema and schema-maintenance sequence as a personal
database. A versioned `initializeContentDb(db, kind)` runs `BASE_SCHEMA`, every existing
`ensure*Schema` repair, then `ensureCrr`, and records the resulting application schema version.
This prevents a newly-created space from missing a later repair that is not expressed in
`BASE_SCHEMA`. It must be tested against a database created by the previous supported client. The
space-list API carries `minimum_client_schema`; a client below that floor neither opens nor syncs
the space and receives `426 SPACE_CLIENT_UPGRADE_REQUIRED` with an upgrade message. The server
raises the floor only after the corresponding frontend has been released.

The CRR `users` table contains only the shared profile `{ id, name }`; it does not replicate member
email addresses. It is populated and updated only by server-owned membership/profile actions.
Clients must not write another user's profile row. It is presentation data, never authorization or
revision attribution.

`settings`, `globals` and `templates` exist in a space database because the schema is shared.
**Globals and templates in a space are space-scoped and shared**; `settings`
in a space database is unused and ignored, because UI preferences are per-person. Do not delete the
table — schema symmetry is worth more than the few unused bytes.

### 3.2 Membership

Membership is **not** replicated. It lives in a new backend-only `data/_spaces.db`, alongside the
existing `_users.db` ([db.js:678-708](../../../backend/api-service/db.js#L678-L708)):

```sql
CREATE TABLE spaces (
  id            TEXT PRIMARY KEY NOT NULL,
  name          TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'pending_delete')),
  delete_after  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE space_members (
  space_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'editor'
             CHECK (role IN ('owner', 'editor')),
  invited_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, user_id)
);

CREATE TABLE space_invites (
  token_hash TEXT PRIMARY KEY NOT NULL,
  space_id   TEXT NOT NULL,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'editor'
             CHECK (role = 'editor'),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_space_members_user ON space_members(user_id);
CREATE UNIQUE INDEX idx_space_members_one_owner
  ON space_members(space_id) WHERE role = 'owner';

CREATE TABLE space_user_versions (
  user_id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
```

Invite tokens are hashed, expiring and single-use — reuse the pattern in
[passwordReset.js](../../../backend/api-service/passwordReset.js) rather than inventing a second
one. Invites create editors only; ownership is never granted through an invite. `spaces.owner_user_id`
and the one `space_members.role = 'owner'` row are updated together in one `_spaces.db` transaction.
The partial unique index prevents a second owner, and every ownership transfer verifies that both
representations agree before commit. An invariant failure aborts and alerts rather than guessing.

Every transaction that changes which spaces a user may access increments that user's
`space_user_versions.version` before commit. Rename/profile changes that alter a member's space-list
payload increment every current member's version. The authenticated, paginated space-list and each
space `/sync` response return the caller's version; clients never supply it as authority. `_spaces.db`
has its own ordered schema version and migrations, separate from content-database migrations.

### 3.3 Server attribution and replica diagnostics

Add backend-only revision actor metadata and a diagnostic replica binding. `note_revisions` gains
nullable `actor_user_id` and `actor_kind` (`sync` | `collab` | `system`) through a normal backend
migration; neither is a CRR column. Every revision created while applying a space sync records
`req.user.user_id`; every collaborative save records its committer. The API exposes this actor only
to current members.

`space_sites` remains a backend-local, non-CRR diagnostic table:

```sql
CREATE TABLE IF NOT EXISTS space_sites (
  site_id    TEXT PRIMARY KEY NOT NULL,   -- 32-char hex
  user_id    TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);
```

On first valid sync, bind the database's reported `siteId` to the authenticated user; later syncs
with that site id must be from the same user or are rejected. This detects accidental reuse but does
not make a client-supplied site id proof of authorship. Never render it as attribution.

### 3.4 Lifecycle, roles and limits

The owner alone may rename a space, invite/remove members, transfer ownership, or request deletion.
An owner cannot remove themselves until ownership is transferred. There is exactly one owner. An
editor may create, edit, delete and transfer content, and manage neither members nor the space.
Role changes take effect before the next request and close subscriptions/sessions for removed users.
An editor may leave a space; leaving immediately revokes access and follows the same local cleanup
and pending-change discard contract as removal. An invited user whose account email changes must be
invited again: pending invites remain bound to the normalized email captured at creation and are not
silently retargeted.

Space deletion is a two-step owner action: atomically set `status = 'pending_delete'` and
`delete_after`, increment all member versions, immediately revoke access, retain
data for 30 days, then delete the database/uploads in a background job. Account deletion requires
the owner to transfer or delete every owned space first. Invites expire after seven days, may be
revoked or resent, and are accepted only by an account matching the normalized invite email.
Authenticated recipients may list their own active, unexpired invitations and accept by the
invitation's non-secret management id; acceptance repeats the email and invite-state checks
transactionally. Discovery responses never contain a raw token.

Initial operational limits are configurable server constants: 20 spaces owned per account, 100
members per space, 100 joined spaces per account, 10 MiB document body, and 1 GiB uploaded images
per space. Exceeding an enforced limit returns a specific error and is surfaced before a destructive
operation. These are product limits, not merely rate limits.

The 200 MiB local space database value is an **advisory warning threshold**, not a sync cutoff:
refusing remote changes based on local size would permanently break convergence. Before bootstrap
and periodically after sync, the client uses the Storage API estimate plus database size to warn and
offer removal of other local space replicas. Actual storage-quota failure pauses only that
database, preserves its clock and queued changes, and exposes retry/removal; it never advances the
clock or reports success.

---

## 4) Backend

### 4.1 Database keys

`getUserDb(userId)` becomes `getDb(dbKey)` where `dbKey` is `user:<uuid>` or `space:<uuid>`.

- `user:` keys resolve to `data/<uuid>.db` — **unchanged**, so no migration of existing databases.
- `space:` keys resolve to `data/spaces/<uuid>.db`.
- The uuid segment is validated against a strict UUID regex **before** it reaches `path.join`, and
  the resolved absolute path is asserted to be contained within its expected root — the same
  containment discipline `image.js` already applies to uploads
  ([image.js:83-84](../../../backend/api-service/image.js#L83-L84)).

Keep `getUserDb(userId)` as a thin wrapper so existing call sites keep working during the
migration.

Every companion function gains the database-key form (`invalidateDb`, `getHealthyDb`,
`getDbSizeBytes`, `getTestDb`, `deleteTestDb`); user-named functions remain thin compatibility
wrappers during migration. `clearConnectionCache` and `closeAllConnections` operate on all keys.

**`listUserDbIds` is the one that will bite.** It feeds the background jobs —
`startImageOrphanPruneJob` and `startRevisionMaintenanceJob`
([index.js:29-30](../../../backend/api-service/index.js#L29-L30)). If it does not enumerate spaces,
space databases silently never get image pruning or revision maintenance, and nobody notices for
months.

The connection cache, health checks and invalidation-on-merge-failure discipline apply to space
databases identically and without exception. A space database is not special.

### 4.2 `/sync`

Accept an optional target in the request body:

```text
POST /sync
Body: { since, siteId, changes, space?: "<spaceId>" }
```

- Absent `space` → the caller's personal database. Unchanged behaviour, wire-compatible with
  existing clients.
- Present → resolve `dbKey`, then **authorize by joining `space_members` on `req.user.user_id`**.
  Never trust a client-supplied user id ([AGENTS.md §4](../../../AGENTS.md)). A non-member gets
  `404`, not `403` — do not confirm the existence of spaces the caller cannot see.
- The authenticated actor is passed to revision capture. A request cannot attribute itself through
  `site_id`, request fields, or CRR `users` rows.
- For a space, validate every incoming CRR change before opening the merge transaction using this
  exact allowlist:

  | Table | Allowed `cid` values |
  |---|---|
  | `folders` | `id`, `name`, `parent_id`, `created_at`, `-1` |
  | `notes` | `id`, `folder_id`, `title`, `content`, `pinned`, `created_at`, `updated_at`, `-1` |
  | `globals` | `key`, `id`, `value`, `created_at`, `updated_at`, `display_key`, `-1` |
  | `templates` | `id`, `name`, `content`, `title_pattern`, `default_folder_id`, `created_at`, `updated_at`, `-1` |

  Reject `users`, `images`, `settings`, unknown tables, `user_id`, and any future column until this
  allowlist is deliberately updated with schema tests. Validate tombstone PKs as strictly as normal
  rows. Images are created/deleted only through authorized image routes, and shared profiles only
  through server membership/profile actions. Reject the whole request with
  `400 SPACE_CHANGE_NOT_ALLOWED`; never merge an allowed subset and return success.

Everything downstream — the merge transaction, revision snapshots, failure handling, connection
invalidation ([sync.js:340-358](../../../backend/api-service/sync.js#L340-L358)) — is unchanged.

`triggerDailyAutoBackup(userId)` ([sync.js:339](../../../backend/api-service/sync.js#L339)) must
**not** fire on a space sync (§6.6).

### 4.3 WebSocket

Today `clients` maps a socket to `{ userId, siteId }`
([index.js:53-71](../../../backend/api-service/index.js#L53-L71)), and the poke fan-out compares
`clientInfo.userId === userId && clientInfo.siteId !== requestorSiteId`
([sync.js:299-312](../../../backend/api-service/sync.js#L299-L312)).

Two changes:

1. A socket subscribes to a **set** of database keys, not one user.
2. **A client has a different `site_id` per local database** — `crsql_site_id()` is per-database.
   So the handshake must carry a `{ dbKey → siteId }` map, and the poke exclusion must compare the
   sender's site id *for that database*. Getting this wrong makes a client either miss pokes or
   loop on its own changes.

Keep the query-param JWT handshake, then use the versioned `subscribe`/`unsubscribe` envelope,
atomic validation, limits, revocation, reconnect and backpressure contract in
[COLLAB-00 §4](collab-00-overview.md). A successful `subscribe` response payload is
`{ subscriptions: [{ dbKey, siteId }], membershipVersion }`; a sync poke is
`{ v: 1, type: "sync", payload: { dbKey } }`. `dbKey`, never a user id or bare space id, is the
routing key. An unauthorized database produces `SPACE_NOT_FOUND`; invalid site ids produce
`INVALID_SITE_ID`; duplicate `dbKey` entries with different site ids produce
`SUBSCRIPTION_CONFLICT`.

This requires an `ws.on('message')` handler, which **does not exist today** — the socket is currently
outbound-only. Every inbound message re-authorizes against `req.user.user_id`; a socket authenticated
once is not a licence to subscribe to anything. Subscription authorization is also rechecked before
each poke. A role change/removal closes affected subscriptions immediately; each `/sync` response
carries the current `membershipVersion`, so a continuously-online client detecting a change refreshes
the paginated space list and performs registry cleanup before its next database retry.

### 4.4 Images

`UPLOADS_DIR` becomes per-database-key: `uploads/<uuid>/` for users (preserving existing paths) and
`uploads/spaces/<uuid>/` for spaces. Keep UUID storage names and the upload-root containment check.

Every image route needs the same treatment — authorization moves from `user_id = ?` to "the caller
may access the database holding this image":

- `GET /images`, `GET /images/stats`, `GET /images/:id`, `GET /images/:id/usage`,
  `POST /images`, `DELETE /images/:id`, `POST /images/bulk-delete`
  ([image.js:262-500](../../../backend/api-service/image.js#L262-L500))

Use canonical, target-qualified image URLs: `/images/:id?space=<spaceId>` for a space and the
legacy URL for personal images. All space-image responses are `Cache-Control: private, no-store`;
they must never be publicly cacheable because their tokenized URL authorizes access. Note
`GET /images/:id` accepts a token via query parameter because `<img src>` cannot set headers
([auth.js:18-21](../../../backend/api-service/auth.js#L18-L21)). That path now grants access to
other people's uploads, so the membership check on it is security-critical, not incidental.

Markdown in a space document references images by URL. A document **moved** between databases
carries image URLs that point at the old database's images — see §5.4.

### 4.5 Revisions

`/notes/:id/revisions*` resolve the database from `getUserDb(req.user.user_id)` and authorize
implicitly by whether the note exists there
([revision.js:276-284](../../../backend/api-service/revision.js#L276-L284)). Add the same optional
space target and membership check. Revisions of a space document are visible to all members — that
is the point — and backend revision actor metadata supplies the author.

### 4.6 PDF and backup

`POST /render-pdf` takes its content from the request body
([pdf.js:393-398](../../../backend/api-service/pdf.js#L393-L398)) rather than reading the database,
so it needs no membership check of its own. Confirm this when implementing; if any code path there
resolves a note id server-side, it needs the same treatment as §4.5. The SSRF DNS/private-IP checks
for external images stay exactly as they are.

**GitHub backup is per-user and stays per-user.** `backup_config` is a local, non-CRR table, and
backing up a shared space to one member's personal repository is a data-governance decision nobody
has made. v1: spaces are excluded, and the backup UI says so explicitly rather than silently
omitting them. This does not exclude spaces from disaster recovery: production backup and restore
tooling must atomically include `data/_spaces.db`, every `data/spaces/*.db` file (including
backend-only revisions and `collab_sessions`) and the matching `uploads/spaces/<spaceId>/` tree.
The restore runbook verifies that membership, database and uploads share the same restored snapshot
timestamp before admitting traffic.

---

## 5) Frontend

This is the bulk of the work.

### 5.1 `syncStore` becomes a registry

Today: one `db` ref, one `crsqlite_site_id`, one `crsqlite_clock`
([syncStore.js:60-135](../../../frontend/src/store/syncStore.js#L60-L135)).

Becomes:

```js
const databases = ref(new Map())   // dbKey => { db, siteId, clock, name, role }
```

- Clocks move to `crsqlite_clock:<dbKey>`, with a one-time migration of the existing
  `crsqlite_clock` value to `crsqlite_clock:user:<id>`.
- Each local database reports its own `crsql_site_id()`; nothing needs generating.
- `sync()` iterates the registry. Run databases **sequentially**, not in parallel — a shared
  connection-failure path and an in-flight merge are not something to exercise concurrently on
  first release.
- A `503 SYNC_CONNECTION_RESET` from one database must not stop the others syncing.
- `initializeDB` opens the personal database first and space databases after the space list loads,
  so first paint does not wait on the network.
- The space-list response is paginated and carries a membership version. A newly accepted member
  bootstraps one space at a time with progress and a recoverable storage-quota failure state; it does
  not block the personal tree. At startup **and whenever a sync/WebSocket response reports a changed
  membership version**, refresh membership before another space retry, remove revoked databases from
  the active registry, and clear their queued changes.

### 5.2 Threading the database key

Every store that calls `syncStore.execute(...)` currently assumes the personal database:
`structureStore`, `docStore`, `templateStore`, `globalVariablesStore`, `imageManagerStore`,
`revisionStore`, `importExportStore`.

Replace ambient database access with an explicit database-scoped repository/context. Public
operations require that context; they do not accept an optional `dbKey` default. The personal-tree
adapter supplies the personal context at legacy call sites during migration. A missing context must
throw in development rather than silently querying a plausible wrong database.

### 5.3 One tree over many databases

`loadRootItems` and `getChildren` run a single SQL query today
([structureStore.js:76-94](../../../frontend/src/store/structureStore.js#L76-L94)). They become
per-database queries unioned in JavaScript, with an in-memory `nodeId → dbKey` index so
`getChildren`, `selectFile`, `renameItem`, `deleteItem` and `moveItem` dispatch correctly.

Spaces render as root nodes below the personal tree, each with its own icon and member stack
([COLLAB-03](collab-03-identity-palette.md)'s `AvatarStack`).

The dashboards need the same treatment. `getRecentDocuments` and `getFolderDocuments` use a
recursive folder-path CTE ([docStore.js:64-150](../../../frontend/src/store/docStore.js#L64-L150)) —
run it per database, tag each row with its `dbKey` and space name, merge, then sort and apply the
limit **after** merging. Applying `LIMIT` per database and concatenating gives wrong results.

### 5.4 Moving between databases

`moveItem` within one database stays an `UPDATE`. Across databases it is a resumable,
server-coordinated transfer:

1. Confirm explicitly — this changes who can read the document. Never silent, never undoable by
   dragging back without a second confirmation.
2. Create a server-owned `space_transfers` record and copy through authenticated server endpoints;
   browser code never accesses an upload root. Map every source folder and image id to a new
   destination id. Rewrite only same-origin canonical image destinations in Markdown image syntax:
   inline `![alt](/images/<uuid>)`, angle-bracket destinations, and referenced-image definitions.
   A personal destination is `/images/<newUuid>`; a space destination is
   `/images/<newUuid>?space=<destinationSpaceUuid>`. Use a Markdown-aware source rewriter that
   preserves the original document outside destination spans and skips fenced/indented code, inline
   code, ordinary links, raw HTML, external/protocol-relative URLs, malformed paths and already
   noncanonical query strings. A canonical source image id absent from source metadata/bytes remains
   unchanged and is recorded as a visible transfer warning; it is never deleted from the text or
   rebound to a guessed image. Persist the id map, warnings and a checkpoint after each stage.
3. Push and verify the copied destination content through the destination database. Delete the source
   only after the server confirms destination rows and image bytes exist and the actor still has both
   permissions.
4. On retry/restart, resume from the transfer record. A failed transfer remains a visible duplicate
   with **Retry**, **Keep both**, and, for the owner/editor, **Delete source** actions; it never
   creates a hole.
5. Tell the user plainly what did not travel: **revision history stays behind**, because revisions
   are backend-local per database and are not replicated.

The operation is intentionally not atomic across two databases; its durable transfer record makes
the intermediate duplicate recoverable and auditable.

### 5.5 UI

- Space list and creation in `SettingsPage` / a new `SpacesPage`, built from `BaseModal`,
  `BaseButton`, `pn-table` and the form primitives in
  [ui-design-system.md §3](../../architecture/ui-design-system.md).
- Invite flow: email + role, sends a hashed single-use token link.
- Manage Spaces lists invitations addressed to the signed-in account and requires an explicit
  **Accept** action; the email landing page remains available and never auto-accepts.
- Member management: role changes and removal, owner only.
- Every space document shows its space in the metadata bar and in dashboard rows, so "who can see
  this" is never a guess.
- Terminology: **Document**, never "file" ([AGENTS.md §4](../../../AGENTS.md)).

---

## 6) Phasing

| Phase | Content | Shippable behind a flag |
|---|---|---|
| 0 | Architecture spike: roles, actor metadata, scoped repository, transfer/revocation contracts | no |
| 1 | `getDb(dbKey)` refactor, versioned initializer, `_spaces.db`, owner/editor membership CRUD | yes: `SHARED_SPACES_ENABLED=false` |
| 2 | `/sync` target, authorization, actor capture, WebSocket subscriptions, limits/rate limits | yes: server capability only |
| 3 | Registry, per-database identity/clock migration, sequential multi-database sync | yes |
| 4 | Scoped stores, unified tree, dashboards, bootstrap/recovery UI | no |
| 5 | Invites, ownership/lifecycle management and revocation cleanup | no |
| 6 | Qualified images, revisions, resumable cross-database transfer, operations tooling | no |

Phase 1 is a pure refactor and should land with the full existing backend suite green before
anything else starts. Phase 0 must produce an approved authorization matrix, transfer state diagram,
and a restore/backup runbook update before Phase 2 begins. The five Phase 0 contracts are specified
in [collab-04-phase-0-design-artifacts.md](collab-04-phase-0-design-artifacts.md).

---

## 7) Tests

Backend (`backend/api-service/tests/`, run via `npm run test:be` in Docker):

- `unit/db.test.js` — `getDb` key parsing; rejects non-UUID, path traversal, absolute paths;
  containment assertions; versioned initialization; `listUserDbIds` enumerates users **and** spaces
- `integration/spaces.test.js` — create, invite, accept, role change, removal; expired token;
  reused token; invite to a non-existent space; owner transfer; owner/account deletion; revocation;
  pending-deletion retention
- `integration/sync.spaces.test.js` — owner/editor sync; non-member gets 404; an attempted viewer
  role is rejected by the API; actor metadata is server-derived; a merge failure in a space database
  invalidates only that connection; every allowed table/column/tombstone is accepted and every
  backend-owned, unknown or future column rejects the entire batch
- `integration/websocket.test.js` — extend: per-database site ids; a space change pokes members
  only; the originating site is excluded; envelope/version/error behavior; subscribe atomicity and
  idempotency; reconnect starts empty; late bootstrap; unauthorized/over-limit subscriptions;
  backpressure; continuously-online revocation
- `integration/image.test.js` — extend: cross-space image access denied on every route including
  the query-token `GET /images/:id`
- `integration/revision.test.js` — extend: member sees space revisions; non-member gets 404

Frontend (`frontend/tests/unit/`):

- `syncRegistry.test.js` — per-database clocks; clock migration from the legacy key; one database
  failing does not stop others; sequential ordering; paginated bootstrap; revoked-space cleanup;
  storage-quota recovery
- `unifiedTree.test.js` — node-to-database index; children resolve to the right database; dashboard
  merge sorts and limits after merging, not before
- `crossDatabaseMove.test.js` — durable checkpoint/resume; destination confirmation precedes delete;
  failure leaves a recoverable duplicate; inline/reference image destinations are rewritten in both
  directions; code, raw HTML, external URLs and missing source images are preserved/warned; revision
  history is reported as left behind
- compatibility/migration — previous supported client is rejected only after the advertised schema
  floor rises; new client treats absent capabilities as disabled; migration failure admits no
  partially initialized space; disabling `SHARED_SPACES_ENABLED` stops new admission without deleting
  databases or transfer records

Manual: two accounts, one space, both editing offline, both reconnecting. Confirm convergence and
that a non-member sees nothing. Restore a backup containing a space and verify its membership,
database and uploads are restored together.

---

## 8) Security checklist

Verify each before merge:

- [ ] Space id validated as a UUID and path-contained before any `path.join`
- [ ] Every space-scoped route joins `space_members` on `req.user.user_id`; no route trusts a
      body- or query-supplied user id
- [ ] Non-membership returns `404`, not `403` — space existence is not disclosed
- [ ] `GET /images/:id` query-token path carries the membership check
- [ ] Invite tokens hashed at rest, expiring, and single-use; the raw token appears only in the
  email or the authenticated owner's immediate create/resend response as a tokenized acceptance
  URL. Invitation detail/list responses never include it.
- [ ] Invite emails do not leak space contents or the member list
- [ ] WebSocket `subscribe` re-authorizes; connect-time auth is not a standing grant
- [ ] Owner-only operations (role change, removal, deletion) enforced server-side, not just in UI
- [ ] Removing a member closes their sockets and invalidates cached subscriptions immediately
- [ ] Removal purges local registry entries and queued sync data on the next membership-version
      observation, including while the client remains online; the UI states that prior replicas
      cannot be recalled
- [ ] Revision attribution is derived from the authenticated actor, never CR-SQLite `site_id`
- [ ] Space profile replication excludes email and rejects client writes to another user's profile
- [ ] `/sync` validates the space-table/column allowlist before any CR-SQLite merge and rejects the
      whole request on a prohibited change
- [ ] Membership version is checked on each sync cycle and WebSocket revocation reaches clients that
      never reload
- [ ] Tokenized space-image responses are private and non-cacheable
- [ ] Request/message size, membership, storage and update-rate limits are enforced and tested
- [ ] No raw errors, stack traces or ids leak in space error responses

**Documented and accepted limitation:** revocation stops future server access and removes the space
from a cooperating client's registry, but cannot recall a replica already copied to a member's disk.
Say so in the sharing UI; do not imply remote erasure.

---

## 9) Risks

- **The frontend refactor is wide and quiet.** A missed call site can read a plausible wrong
  database. Require an explicit scoped context and make missing scope fail in development.
- **Background jobs skipping spaces.** See §4.1. Test `listUserDbIds` directly.
- **Connection-cache growth.** One process now holds a handle per user *and* per space. Add an idle
  eviction policy, and make sure eviction respects the sync-bit health discipline in
  [crsqlite-sync.md](../../architecture/crsqlite-sync.md).
- **Disk layout change.** `data/spaces/` and `uploads/spaces/` must be inside the existing Docker
  volumes, or spaces evaporate on redeploy. Check
  [docs/runbooks/deployment.md](../../runbooks/deployment.md) and `docker-compose.yml` before
  Phase 1.
- **Operational blindness.** Before Phase 2, add metrics and alerts for open database handles,
  sync failures by database key, transfer age/failure, live-session recovery failures, snapshot
  storage, and space storage quota. Alert thresholds and the backup/restore drill belong in the
  operations runbook.
