# COLLAB-03 — Identity Palette

Agent: Zed coding agent
Start: 2026-08-16 22:16 +02:00
Status: Complete

## Objective

Add the identity colour palette, the avatar primitives that do not yet exist, the design-system
amendment, and the verification script — the explicit exception that lets presence UI identify
people by colour without violating the "blue is for links, gray is for controls" contract.

## Progress

- Added `IDENTITY_PALETTE` (8 mid-tone colours) with deterministic FNV-1a assignment from the
  canonical ASCII user UUID, plus `initialsFor` for name/email/fallback initials.
- Added `UserAvatar.vue` (sizes xs/sm/md, white initials, accessible label, focusable tooltip,
  optional gray-tone status dot) and `AvatarStack.vue` (`+N` overflow pill).
- Added `scripts/verify-identity-palette.cjs` backed by a shared
  `frontend/src/utils/identityPaletteVerify.js` (WCAG 2.1 relative-luminance contrast and CIEDE2000
  colour distance).
- Amended `docs/architecture/ui-design-system.md` with the identity-palette exception.

## Changes Made

- `frontend/src/utils/identityColor.js` (new)
- `frontend/src/utils/identityPaletteVerify.js` (new)
- `frontend/src/components/UserAvatar.vue` (new)
- `frontend/src/components/AvatarStack.vue` (new)
- `scripts/verify-identity-palette.cjs` (new)
- `docs/architecture/ui-design-system.md` (§6)
- `frontend/tests/unit/identityColor.test.js`, `userAvatar.test.js`, `userAvatarComponent.test.js` (new)

## Tests

- `node scripts/verify-identity-palette.cjs`
  - PASS: every swatch satisfies contrast, colour-distance and hue constraints. Spot-checked
    `rose vs white = 5.51` and `rose vs dark = 3.31`, matching the spec's table.
- `cd frontend && npx vitest run tests/unit/identityColor.test.js tests/unit/userAvatar.test.js tests/unit/userAvatarComponent.test.js`
  - Passed: 21 tests in 3 files (assignment stability/distribution, contrast ≥3:1 vs both surfaces,
    initials ≥4.5:1, Delta E ≥12 from primary/accent, hue outside 200–260°, initials derivation,
    aria-label, `+N` overflow).
- `cd frontend && npm test`
  - Passed: 409 tests in 29 files (includes COLLAB-01 and COLLAB-03 additions).

## Open Items / Notes

- COLLAB-04/05 will consume `UserAvatar`/`AvatarStack` for participant rosters. The spec notes that
  blue is intentionally absent and violet is excluded for dark-mode confusability with the primary
  button colour; the verifier encodes both rules as tests.
- Collisions at the 8-colour palette are accepted by design; initials/name remain the primary
  identity channels.
