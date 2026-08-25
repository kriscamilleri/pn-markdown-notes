# Local collaboration smoke test

- Agent: Copilot CLI
- Started: 2026-08-19 07:29 CEST
- Status: complete

## Objective

Run the collaboration-enabled local stack and verify shared-space lifecycle UI plus the
two-user live editing protocol.

## Progress

- Recreated the development Docker Compose stack with `SHARED_SPACES_ENABLED=true` and
  `LIVE_SESSIONS_ENABLED=true`.
- Found that stale anonymous `node_modules` volumes masked the image-installed `yjs` and
  `@panino/content-merge` dependencies, causing Vite import-resolution failures.
- Recreated the stack with `--renew-anon-volumes`; the dependencies then resolved and the
  frontend loaded normally.
- Created disposable local test accounts. In the browser, created `Local Collab Smoke Test`
  and created a pending invitation for the second account.

## Changes Made

- No application-source changes.
- Added this verification log.
- The local development stack remains running with collaboration flags enabled at
  `http://localhost:5173`.

## Tests

- `npm run test:be -- tests/integration/collab.test.js` — passed (1 file, 7 tests).
  This covers two authenticated collaborators, Yjs update forwarding, durable commit and
  revision attribution, recovery, merge/conflict handling, disabled-feature rejection,
  membership revocation, and graceful-shutdown persistence.
- Browser smoke test at `http://localhost:5173/#/spaces` — passed. The shared-space
  management screen rendered, a space was created, and its pending invitation appeared.

## Open Items / Notes

- The embedded browser pages share local storage, so they cannot keep two identities signed
  in simultaneously. The existing backend integration test supplies the two-client protocol
  validation.
- If newly added dependencies appear missing after changing package manifests, renew anonymous
  Compose volumes with `docker compose -f docker-compose.dev.yml up --build --renew-anon-volumes -d`.
