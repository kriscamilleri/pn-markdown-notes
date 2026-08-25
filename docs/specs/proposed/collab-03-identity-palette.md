# COLLAB-03 — Identity Palette

> A colour vocabulary for *people*, carved out of a design system that reserves colour for nothing.
> Status: proposed
> Created: 2026-08-16
> Last updated: 2026-08-16 (final review)
> Part of [COLLAB-00](collab-00-overview.md)

---

## 1) Summary

Every collaborative product identifies people by colour. Panino's design system forbids it:

> **Accent** — `gray-800` / `gray-900`. Blue is reserved for hyperlinks only — never for primary
> buttons, selection states, focus rings or progress.
> — [ui-design-system.md §1](../../architecture/ui-design-system.md)

This is a real conflict, and the wrong resolution is to quietly add a blue avatar and move on. This
spec defines an **identity palette** as an explicit, documented exception — colours that encode
*who someone is*, never *what a control does* — amends the design system in the same change, and
adds the avatar primitive that does not currently exist.

Small spec, but it blocks the visual work in [COLLAB-04](collab-04-shared-spaces.md) and
[COLLAB-05](collab-05-live-sessions.md). Retrofitting it afterwards means touching every presence
surface twice.

---

## 2) The constraint dark mode imposes

Dark mode in this repo is not a token swap — it **remaps Tailwind utility classes**:

```css
html[data-theme='dark'] .bg-white { background-color: var(--pn-surface-elevated); }
html[data-theme='dark'] .bg-gray-50 { background-color: var(--pn-surface-inset); }
```
— [main.css:195-232](../../../frontend/src/assets/main.css#L195-L232)

Hard-coded identity colours are not remapped, which is what we want — a person should be
recognisably the same colour in both themes. But the surface behind them moves from `#ffffff` to
`--pn-surface: #151515`, so **every identity colour must clear contrast against both**.

That rules out most of a conventional palette. Pale colours vanish on white; deep ones vanish on
near-black. Only mid-tones survive.

---

## 3) The palette

Verified against WCAG 2.1 relative luminance: ≥3:1 for the swatch against **both** surfaces
(graphical object threshold), and ≥4.5:1 for the initials on the swatch (text threshold).

| Name | Hex | vs `#ffffff` | vs `#151515` | Initials |
|---|---|---|---|---|
| rose | `#be3455` | 5.51 | 3.31 | white (5.51) |
| orange | `#c2410c` | 5.18 | 3.53 | white (5.18) |
| amber | `#a16207` | 4.92 | 3.71 | white (4.92) |
| olive | `#4d7c0f` | 4.99 | 3.66 | white (4.99) |
| green | `#15803d` | 5.02 | 3.64 | white (5.02) |
| teal | `#0f766e` | 5.47 | 3.34 | white (5.47) |
| cyan | `#0e7490` | 5.36 | 3.41 | white (5.36) |
| pink | `#be185d` | 6.04 | 3.02 | white (6.04) |

All eight take **white** initials in both themes, which keeps the avatar component free of theme
logic.

Three honest caveats:

- **Hue separation degrades at eight.** rose/pink and teal/cyan are adjacent. Colour is a
  *secondary* identifier; initials are primary, and the full name must be available on hover and to
  assistive technology.
- **Blue is absent by design.** Not because it fails contrast — `#1d4ed8` scores 6.70 on white —
  but because it reads as a hyperlink.
- **Two colours were rejected for dark-mode collision, not contrast.** In dark mode
  `bg-gray-800` maps to `--pn-primary: #77a0a5` and `bg-gray-900` to `--pn-accent: #9377a5` — the
  primary-button colours. Teal-family and violet-family identity colours sit close enough to be
  confused with a button. `#0f766e` is dark enough to be distinguishable and is kept; violet
  (`#7c3aed`, otherwise passing at 5.70 / 3.20) is **excluded**.

Regenerate or re-verify with the script the values came from:

```bash
node scripts/verify-identity-palette.cjs   # added by this spec
```

The verifier uses WCAG 2.1 relative luminance for contrast and CIEDE2000 for colour distance.
An identity swatch must be at least Delta E 12 from both `--pn-primary` and `--pn-accent`; a
candidate whose hue, converted to HSL, is in the inclusive 200-260 degree blue range is rejected.
Those rules make "confusable" and "blue-family" testable rather than editorial judgements.

---

## 4) Assignment

Deterministic from the user id, so the same person is the same colour on every device with no
coordination and no server round-trip. `userId` is always Panino's canonical ASCII UUID; callers
must not pass a display name, email or arbitrary Unicode identifier. Therefore FNV-1a over
`charCodeAt` processes identical single-byte code points in every supported runtime:

```js
// frontend/src/utils/identityColor.js
export function identityColorFor(userId) {
  let h = 0x811c9dc5;                       // FNV-1a
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return IDENTITY_PALETTE[h % IDENTITY_PALETTE.length];
}
```

Collisions are accepted rather than resolved. COLLAB-00 caps a live session at 20 distinct users,
so eight colours make collisions expected rather than exceptional: under uniform hashing the
probability of at least one collision is about 99.8% at eight people, and by the pigeonhole
principle a 9-person session is guaranteed at least one. Greedy per-session reassignment
would avoid some of them but
would make the same person a different colour to different viewers, which is worse — two people
describing "the green one" must mean the same person. Initials and name disambiguate.

---

## 5) Rules for the exception

Add to [ui-design-system.md](../../architecture/ui-design-system.md) as a new section, in the same
commit as the code:

1. Identity colours identify **people only** — avatars, presence dots, attribution marks, remote
   selection tints.
2. They are never used for a control, a state, a focus ring, progress, or a severity. Those remain
   `gray-800`/`gray-900` and the `pn-alert-*` variants.
3. They are never the sole carrier of meaning. Always paired with initials or a name.
4. They are hard-coded hex, deliberately not remapped in dark mode.
5. New identity colours must pass the §3 thresholds against both surfaces and be checked against
   `--pn-primary` and `--pn-accent` for confusability.

---

## 6) `UserAvatar.vue`

There is no avatar component today; [ui-design-system.md §1](../../architecture/ui-design-system.md)
mentions `rounded-full` for avatars but nothing implements it.

```vue
<UserAvatar :user="{ id, name, email }" size="sm" :show-tooltip="true" />
```

- `size`: `xs` (16px, inline in a list row) · `sm` (24px, default, toolbars and rosters) ·
  `md` (32px, dialogs).
- Renders a `rounded-full` swatch in the assigned colour with up to two white initials derived from
  `name`, falling back to the email local part, then `?`.
- `aria-label` is the full name, or `Unknown collaborator` when no usable name/email exists — never
  colour alone.
- A keyboard-focusable tooltip shows the full name on hover, focus and touch activation; `title`
  alone is not an accessibility mechanism.
- Optional `status` dot (`online` / `idle` / `offline`) for [COLLAB-05](collab-05-live-sessions.md),
  rendered in gray tones — **status is a state, so it does not use the identity palette**.
- Test id `user-avatar`, plus `:data-user-id`.

An `AvatarStack.vue` wrapper renders up to *n* overlapping avatars with a `+N` gray pill overflow,
for participant rosters.

---

## 7) Files touched

| File | Change |
|---|---|
| `frontend/src/utils/identityColor.js` | **New.** Palette constant and assignment |
| `frontend/src/components/UserAvatar.vue` | **New.** |
| `frontend/src/components/AvatarStack.vue` | **New.** |
| `frontend/src/assets/main.css` | `pn-avatar` sizing primitives if the sizes are shared |
| `docs/architecture/ui-design-system.md` | New section documenting the exception |
| `scripts/verify-identity-palette.cjs` | **New.** Contrast verification |

No backend changes. No schema changes. No store changes.

---

## 8) Tests

`frontend/tests/unit/identityColor.test.js`:

- assignment is stable for a given id across calls
- assignment is distributed across the palette for a sample of UUIDs (no single-bucket collapse)
- every palette entry passes ≥3:1 against `#ffffff` **and** `#151515`
- every palette entry passes ≥4.5:1 against white initials
- no palette entry is within a small perceptual distance of `--pn-primary` or `--pn-accent`
- every distance is Delta E >=12 and every hue is outside 200-260 degrees
- unknown/missing users receive the accessible fallback label
- the avatar remains distinguishable with simulated common colour-vision deficiencies because
  initials/name, not hue, carry identity

`frontend/tests/unit/userAvatar.test.js`:

- initials from a two-word name, a one-word name, an email-only user, and an empty user
- `aria-label` carries the full name
- `AvatarStack` overflow renders `+N` past the cap

The contrast assertions are the important ones — they are what stop a future contributor adding a
pastel that disappears in light mode.

---

## 9) Risks

- **Scope creep into a general colour system.** This exception is for people. If a future spec
  wants colour for tags ([tag-system.md](tag-system.md) proposes exactly that, with its own
  ten-colour palette), the two must be reconciled deliberately — a document tagged "urgent" in rose
  next to a person rendered in rose is a real ambiguity. Flag it when tags are picked up; do not
  pre-emptively merge the palettes here.
- **Dark-mode drift.** `--pn-primary` and `--pn-accent` may change. The confusability test in §8
  turns that from a silent regression into a failing build.
