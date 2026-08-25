# Manual invitation links

- Agent: Copilot CLI
- Started: 2026-08-20 08:29 CEST
- Status: complete

## Objective

Allow a shared-space owner to copy a pending invitation link for manual delivery while preserving
the invitation security model.

## Progress

- Reviewed the existing invitation lifecycle, acceptance route, owner-only detail view, and
  frontend store/page tests.
- Identified that the raw token was available only for sending email and was not retained after
  hashing, so existing invitation-detail responses cannot safely reconstruct it.
- Added a replacement-link action for any pending invitation and a direct copy action for a
  link created in the current page session.

## Changes Made

- The create and resend endpoints now return `invitationUrl` only in the authenticated owner's
  immediate response. The URL contains the raw, email-bound, expiring, single-use token; no
  separate `token` field is returned.
- Invitation detail/list responses remain metadata-only and tokens remain hashed at rest.
- The owner UI now offers **Copy new link** for every pending invitation. It invalidates the old
  link, creates and copies a replacement, and continues the existing email resend behavior.
  A newly generated current-session link also has a **Copy link** action.
- Updated the shared-spaces specification to state the narrow owner-response exception.

## Tests

- `npm run test:be -- tests/integration/spaces.lifecycle.test.js` — passed (5 tests).
- `npm --prefix frontend test -- tests/unit/spacesPage.test.js tests/unit/spacesStore.test.js`
  — passed (9 tests).
- `npm run lint` — passed.
- `npm --prefix frontend run build` — passed; existing Vite dynamic-import and chunk-size warnings
  remained.
- Browser validation at local `/spaces` — passed. A pending invitation showed **Copy new link**;
  activating it created a replacement link and confirmed it was copied. No token value was recorded.

## Open Items / Notes

- The feature is local-only until the feature branch is deployed with
  `SHARED_SPACES_ENABLED=true`.
- In local development, clear the service worker cache after a frontend source change if Vite HMR
  has disconnected during a container restart.
