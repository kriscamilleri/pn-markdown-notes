# Backend — Agent Reference

> Layer-specific reference for agents working on the backend API service.
> Always read the root `AGENTS.md` first for project-wide rules, architecture, database schema, and security guidelines.

---

## Module Map

All code lives under `backend/api-service/`. The entry point is `index.js`, which exports a `createApp()` factory (used directly by tests).

| File | Responsibility | Auth |
|------|---------------|------|
| `index.js` | Express app factory, HTTP server, WebSocket server, route mounting | — |
| `auth.js` | `POST /login`, `POST /refresh`, `GET /me`, `POST /me/password`, `authenticateToken` middleware | Mixed |
| `signup.js` | `POST /signup` with Turnstile CAPTCHA verification | Public |
| `passwordReset.js` | `POST /forgot-password`, `POST /reset-password` | Public |
| `sync.js` | `POST /sync` — bidirectional CR-SQLite change set exchange; optional flag-gated `space` UUID routes the batch at a shared-space content DB behind membership + an exact table/column allowlist (Phase 2; no public space routes yet) | Authenticated |
| `image.js` | `POST /images` (upload), `GET /images/:id` (serve) | Authenticated |
| `pdf.js` | `POST /render-pdf` — Puppeteer HTML→PDF with queued processing | Authenticated |
| `backup.js` | GitHub OAuth, repository selection, snapshot commits, auto-backup scheduling | Mixed |
| `revision.js` | Note revision capture, listing, detail, restore, and pruning; snapshots may carry a nullable server-derived `actor_user_id`/`actor_kind` (`sync`\|`collab`\|`system`) — never accepted from client input | Authenticated |
| `db.js` | Canonical `getDb(dbKey)` content connections, user compatibility wrappers, versioned content initialization, auth/space metadata DBs, connection caching, CR-SQLite extension loading | — |
| `spaces.js` | Flag-gated discovery and lifecycle: create/rename, hashed email-bound editor invitations, member removal, ownership transfer, editor leave, pending deletion, membership-version fan-out, and retained-space purge scheduling | Authenticated / trusted server callers |
| `spaceStorage.js` | UUID/path-contained shared-space upload-root resolution and retained upload-tree deletion | Trusted server callers |
| `websocket.js` | COLLAB-00 v1 subscribe/unsubscribe envelope (`{v:1,type:'subscribe',requestId,payload:{databases:[{dbKey,siteId}]}}` / `{v:1,type:'unsubscribe',requestId,payload:{dbKeys:[...]}}`, success response payload `{subscriptions,membershipVersion}`) layered over the legacy handshake; per-connection subscription state, atomic/idempotent (un)subscribe validation, membership re-check on every subscribe and poke, `pokePersonalClients()`/`pokeSpaceSubscribers()` targeted sync notifications with site-id self-exclusion, backpressure/connection-limit guards | Authenticated (JWT at handshake) |
| `db-repair.js` | Orphan-clock detection and repair helpers used by the incident tooling | — |
| `mailer.js` | Nodemailer transport, `sendPasswordResetEmail()` | — |

`scripts/repair-orphan-image-clocks.mjs` is the operator-facing CLI wrapper around
`db-repair.js`. Do not run it against production without reading
[`docs/runbooks/sync-incident-response.md`](../../docs/runbooks/sync-incident-response.md)
first — it defaults to a dry run and requires `--apply` to mutate anything.

---

## Route Mounting Order (in `index.js`)

1. Public routes: `signupRoutes`, `passwordResetRoutes`
2. Mixed routes: `authRoutes` (login is public, /me and /refresh need auth)
3. `authenticateToken` middleware (all routes after this require auth)
4. Authenticated routes: `syncRoutes`, `spaceRoutes`, `imageRoutes`, `pdfRoutes`

---

## Authentication Pattern

- JWT token with `{ user_id, sub, name, email }` payload, 7-day expiry.
- Frontend stores token in `localStorage` as `jwt_token`.
- Backend extracts from `Authorization: Bearer <token>` header, with fallback to `?token=<jwt>` query param (for `<img>` tags).
- `authenticateToken` middleware sets `req.user = { user_id }`.
- **Never trust `req.body.userId`** — always use `req.user.user_id` from the middleware.

---

## Database Architecture

Three database classes:
1. **Auth DB** (`data/_users.db`) — single shared DB for `users` and `password_resets`. Access via `getAuthDb()`.
2. **Space metadata DB** (`data/_spaces.db`) — backend-only spaces, memberships, invites, and membership versions. Access via `getSpacesDb()`.
3. **Content DBs** — personal `data/{uuid}.db` and shared `data/spaces/{uuid}.db`, addressed by canonical keys `user:<uuid>` and `space:<uuid>` through `getDb(dbKey)`. `getUserDb(userId)` remains a thin compatibility wrapper.

`initializeContentDb(db, kind)` applies the shared content schema and records its ordered application version; personal-only backup configuration is omitted from space DBs. Connection caching uses canonical dbKeys (plus `'_auth'`/`'_spaces'`). Content connections get WAL mode and normal synchronous pragma.

CR-SQLite is a vendored loadable extension at `native/crsqlite.so`. It is loaded
per-connection. The vendored binary targets Linux x86_64; use `CRSQLITE_EXT_PATH` to supply
a compatible extension on another platform.

---

## WebSocket Protocol

- Client connects with `?token=<jwt>&siteId=<hex>` query params (legacy handshake, unchanged). Server verifies JWT and associates `{ userId, siteId }` with the connection.
- Every connection starts with **no subscriptions**. Legacy same-user poke behavior is preserved as an implicit personal subscription: after a personal (non-space) sync, the server sends `{ type: 'sync' }` to same-user connections except the sender.
- COLLAB-00 v1 envelope (`websocket.js`, flag-independent — always available) layers explicit subscribe/unsubscribe messages over the same connection for shared-space (and personal) dbKeys: a subscribe request is `{v:1,type:'subscribe',requestId,payload:{databases:[{dbKey,siteId}]}}`; an unsubscribe request is `{v:1,type:'unsubscribe',requestId,payload:{dbKeys:[...]}}`. The request field names (`databases`, `dbKeys`) are deliberately distinct from the response's `subscriptions` field below and must not be aliased.
  - `requestId` must be a UUID; validation and application of a batch are atomic (all-or-nothing) and idempotent (re-subscribing the same `dbKey`+`siteId` is a no-op).
  - `dbKey` must be `user:<own-uuid>` (authorized only if it matches the JWT actor) or `space:<uuid>` (authorized only through active membership, re-checked on every subscribe **and** every poke); `siteId` must be exactly 32 lowercase hex characters. Unauthorized/unknown targets and real "not a member" cases return the same non-disclosing error.
  - A `dbKey` already subscribed under a different `siteId` is a conflict and is rejected without mutation. Control messages are capped at 64KiB; a connection may hold at most 100 space subscriptions plus 1 personal subscription.
  - Successful `subscribe` responses echo the resulting `subscriptions` plus the space's current `membershipVersion` (when applicable).
  - Malformed JSON, unsupported `v`, or unknown `type` get a versioned error reply and never mutate subscription state; the connection remains usable afterward.
  - Space sync pokes only currently-subscribed, still-authorized connections for that exact `dbKey`, excluding the originating site id, as `{v:1,type:'sync',payload:{dbKey}}`. A subscription that fails re-authorization at poke time is dropped and (where the socket is still open) replaced with a `{v:1,type:'subscription:revoked',...}` notice instead of a sync poke.
  - Backpressure (4MiB `bufferedAmount`) closes a connection; a per-user connection cap is enforced. No user IDs are logged.
- WebSocket server and clients Map are attached to every request via middleware (`req.wss`, `req.clients`).

---

## PDF Generation

- Single Puppeteer browser instance reused across requests.
- Requests queued and processed sequentially to limit memory.
- Images pre-embedded as data URIs (both internal DB images and external URLs).
- SSRF protection: DNS lookup + private IP check before fetching external images.
- Page numbers resolved via draft PDF render + pdf-lib page count.
- HTML sanitized with DOMPurify before rendering.
- Print style defaults are the `PRINT_STYLE_DEFAULTS` constant in `pdf.js`. Incoming
  `printStyles` are merged over them. `poc/` is a proof of concept and is not on any
  production code path — do not reintroduce a dependency on it.

---

## Code Conventions

- Express Router for each feature module, exported as named const (e.g., `export const authRoutes = express.Router()`).
- Route handlers use `try/catch` with `res.status(500).json({ error: '...' })` for error responses.
- `getDb('user:<uuid>' | 'space:<uuid>')` for content DB access; use `getUserDb(userId)` only at legacy personal call sites. `getAuthDb()` and `getSpacesDb()` own backend metadata.
- Password hashing: `bcryptjs` with 10 salt rounds.
- JSON body limit: `50mb` (for sync payloads with large content).
- Image upload limit: `10MB` via multer.
- UUID filenames for stored images (never use original filename for storage path).
- `CORP: cross-origin` header on all responses (middleware in `index.js`) for frontend COEP compliance.

---

## Testing

### Framework & config

- **Vitest** with `globals: true` (no need to import `describe`/`it`/`expect`).
- **supertest** for HTTP integration tests.
- Setup file: `tests/setup.js` — sets `JWT_SECRET` and `NODE_ENV=test`, calls `closeAllConnections()` after each test.
- Config: `vitest.config.js` with `testTimeout: 10000`, v8 coverage provider.

### Running tests

```bash
# From backend/api-service directory
npm test              # vitest run (single pass)
npm run test:watch    # vitest (watch mode)
npm run test:coverage # vitest with v8 coverage

# Via Docker
docker build -f Dockerfile.test -t panino-test .
docker run --rm panino-test
```

The canonical repository command is `npm run test:be` from the repository root. It builds
and runs `Dockerfile.test` with Node 24, matching production and avoiding native binding ABI
mismatches on other host Node versions. Use `npm test` here only on Node 24 — and after
`npm run native:setup` (builds `better-sqlite3` and fetches Puppeteer's Chrome build;
installs skip these automatically, see `.npmrc`). The vendored CR-SQLite extension has no
install step.

### Directory structure

```
tests/
├── setup.js              # Global setup (env vars, cleanup)
├── testHelpers.js        # createTestApp(), getTestToken(), setupTestUser(), cleanupTestUser()
├── fixtures/
│   ├── users.js          # Predefined test users (alice, bob) with pre-hashed passwords
│   └── changes.js        # Sample CRDT change objects for sync tests
├── unit/
│   ├── auth.test.js      # authenticateToken middleware unit tests
│   ├── db.test.js        # Database utility tests
│   ├── db-repair.test.js # Orphan-clock detection and repair helpers
│   ├── revision.test.js  # actor_user_id/actor_kind validation helpers
│   ├── spaces.test.js    # assertSpacesInvariants + membership repository
│   └── sync.test.js      # Sync helper function tests
└── integration/
    ├── auth.test.js               # POST /login, token validation end-to-end
    ├── backup.test.js             # GitHub backup flow
    ├── image.test.js              # Image upload, retrieval, and orphan prune
    ├── me.test.js                 # GET /me, POST /me/password
    ├── passwordReset.test.js
    ├── pdf.test.js                # PDF generation
    ├── revision.test.js           # Revision list, detail, restore
    ├── sync.test.js               # Sync endpoint integration
    ├── sync.revision.test.js      # Revision capture driven by incoming change sets
    ├── sync.spaces.test.js        # Flag-gated space-aware /sync: membership, allowlist, actor, invalidation
    ├── websocket.test.js          # Legacy handshake + personal poke tests
    └── websocket.spaces.test.js   # v1 subscribe/unsubscribe protocol + space-scoped poke tests
```

### Test helper API

```javascript
import { createTestApp, getTestToken, setupTestUser, cleanupTestUser, generateSiteId } from '../testHelpers.js';

// Create app instance (uses createApp() factory from index.js)
const { app, server } = createTestApp();

// Create a test user in auth DB, returns { userId, email, password }
const testUser = await setupTestUser('test@example.com', 'password123');

// Generate a JWT for the test user
const token = getTestToken(testUser.userId);

// Clean up after test (removes from auth DB + deletes user DB files)
cleanupTestUser(testUser.userId);

// Generate a 32-char hex site_id
const siteId = generateSiteId('a');
```

### Writing new tests

- **Unit tests** go in `tests/unit/` — test exported functions in isolation with mocked deps.
- **Integration tests** go in `tests/integration/` — test HTTP endpoints via supertest against the real app.
- Use `beforeAll` to create app, `beforeEach` to set up test data, `afterEach` to clean up, `afterAll` to close server.
- Mock pattern: use `vi.fn()` for Express `req`/`res`/`next`.
- Always test: happy path, invalid input, authentication enforcement, edge cases.
- Close server in `afterAll` with: `return new Promise(resolve => server.close(resolve))`.
