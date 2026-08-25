# Collaboration spec set (COLLAB-00…05)

- Agent: Claude Opus 5 (Claude Code)
- Start: 2026-08-16 20:40
- Status: complete — six specs written to `docs/specs/proposed/`, no code changed

## Objective

Answer whether Panino can support collaborative access to shared document folders given
CR-SQLite's constraints and the local-first architecture, then produce an implementable spec set
for the design that came out of it.

## Progress

### Architecture analysis

Read `backend/api-service/sync.js`, `db.js`, `auth.js`, `image.js`, `revision.js`, `index.js`,
`frontend/src/store/syncStore.js`, `docStore.js`, `structureStore.js`, `draftStore.js`,
`historyStore.js`, `components/Editor.vue`, `OfflineIndicator.vue`, and
`docs/architecture/{crsqlite-sync,data-model,ui-design-system}.md`.

Findings that shaped the design:

1. **Row-filtered sync is unworkable.** `/sync` returns `clock = max(db_version)` over the whole
   `crsql_changes` table (`sync.js:329-332`) and the client advances its cursor to it
   (`syncStore.js:72-77`). Filtering rows out of a response makes the client skip them
   permanently. Tombstones compound it — a delete arrives as `cid = '-1'` with no base row, so a
   deleted document's folder cannot be determined after the fact. Therefore a shared folder must be
   a **separate database**, matching CR-SQLite's natural replication unit.

2. **An active data-loss bug, unrelated to collaboration.** `Editor.vue:430` watches
   `file.value?.id`, not content. A remote edit re-fetched by `refreshData` → `reFetchSelectedFile`
   never reaches the open editor, and the next keystroke's `debouncedSyncToDB` (`Editor.vue:168-170`)
   writes a full-body `UPDATE` over it. Reproducible today with one user and two browsers. CR-SQLite
   is not involved.

3. **`docStore.isSaving` is dead code.** Set with a deliberate 300ms visibility floor
   (`docStore.js:177-196`), read by no `.vue` file. There is currently no persistence indicator in
   the editor at all.

4. **The design system has no room for presence colour.** `ui-design-system.md §1` reserves blue
   for hyperlinks and fixes the accent at `gray-800`/`gray-900`. Dark mode remaps Tailwind utility
   classes (`main.css:195-232`) rather than swapping tokens, so hard-coded identity colours are not
   remapped and must clear contrast against both `#ffffff` and `--pn-surface: #151515`.

5. **The WebSocket is outbound-only.** No `ws.on('message')` handler exists
   (`index.js:53-71`); it only pokes clients. Any collaboration protocol is new inbound surface
   needing per-message authorization.

6. **`diff` v8 removed three-way merge.** The package is already a dependency and is used at
   `RevisionPanel.vue:94`, but v8 exports only `diffLines`/patch functions — no `merge` or
   `diff3Merge` as v5–v7 had. Verified by enumerating the installed build's exports. A merge
   implementation therefore needs `node-diff3` or equivalent; the jsdiff-only patch-transfer
   fallback is all-or-nothing and was rejected.

7. **`listUserDbIds` feeds the background jobs** (`index.js:29-30`). Any multi-database refactor
   that misses it leaves the new databases without image pruning or revision maintenance, silently.

### Design decisions recorded in COLLAB-00 §4

- Shared folders are separate CR-SQLite databases, not filtered rows or a backend relay.
- The co-editing CRDT is **session-scoped and ephemeral**, not a persistent op log in a CRR table.
  This avoids op-log compaction, a CRDT runtime in the merge hot path, and binary payloads through
  `toBufferLike`'s heuristic coercion (`sync.js:23-62`).
- No second realtime transport; extend the existing WebSocket.

### Identity palette verification

Computed WCAG relative-luminance contrast for 20 candidate colours against both surfaces. Ten pass
≥3:1 on both with ≥4.5:1 for white initials; eight were selected. Violet (`#7c3aed`) was excluded
despite passing, because dark mode maps `bg-gray-900` to `--pn-accent: #9377a5` and the two would be
confusable with a primary button. Values and ratios are in COLLAB-03 §3.

## Changes Made

Six new specs in `docs/specs/proposed/`, no code changes:

| File | Content |
|---|---|
| `collab-00-overview.md` | Index, sequencing, recorded decisions, set-wide non-goals, cheaper read-only alternative |
| `collab-01-editor-conflict-safety.md` | P0 fix for finding 2, plus the first persistence indicator |
| `collab-02-content-merge.md` | Durable base table, three-way merge at sync boundaries |
| `collab-03-identity-palette.md` | Verified palette, `UserAvatar`/`AvatarStack`, design-system amendment |
| `collab-04-shared-spaces.md` | Space databases, membership, multi-database backend and frontend |
| `collab-05-live-sessions.md` | Session-scoped Yjs, WebSocket protocol, commit semantics |

## Tests

None run — documentation-only change. No source files were modified; `git status` shows only the
six new specs.

Each spec carries its own test plan. COLLAB-01 and COLLAB-02 are testable with the existing vitest
setup; COLLAB-04 and COLLAB-05 extend `backend/api-service/tests/integration/`. The repository has
no e2e harness, so all three UI-facing specs require manual browser validation, and the
reproduction in COLLAB-01 §2 is the one to run first.

## Open Items / Notes

- **Confirm the requirement before COLLAB-04 starts.** If the need is only "let someone *read* my
  folder", a server-rendered read-only share link is roughly two days against COLLAB-04's three
  weeks. Recorded in COLLAB-00 §6.
- **COLLAB-05 §5.2 is load-bearing.** The backend is `restart: always` and `deploy.sh` restarts
  containers, so in-memory sessions die on every deploy. Snapshot persistence and a `SIGTERM` flush
  must land with the session manager, not after it.
- **Disk layout.** `data/spaces/` and `uploads/spaces/` must sit inside the existing Docker
  volumes. Check `docs/runbooks/deployment.md` and `docker-compose.yml` before COLLAB-04 Phase 1.
- **Palette collision with the tag system.** `docs/specs/proposed/tag-system.md` proposes its own
  ten-colour palette. A document tagged in rose beside a person rendered in rose is ambiguous.
  Flagged in COLLAB-03 §9; reconcile when tags are picked up rather than pre-emptively.
- Effort estimates for COLLAB-04 (~3 weeks) and COLLAB-05 (~4 weeks) are the least reliable figures
  in the set.
- Nothing was promoted to `docs/architecture/` — these are intentions, not current behaviour. The
  findings about `crsql_changes` cursor semantics would be worth promoting **if** COLLAB-04 ships.
