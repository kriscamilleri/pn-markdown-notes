# UI Design System

The rules every Panino surface follows, and the primitives that enforce them. Read this
before adding a dialog, button, form control or table — the point is that a new surface
should be assembled from these pieces, not styled from scratch.

Primitives live in `frontend/src/components/` (Vue) and
`frontend/src/assets/main.css` (`@layer components` classes prefixed `pn-`).

Dark mode is activated at `html[data-theme="dark"]`. Its shared mappings also live in
`frontend/src/assets/main.css` after Tailwind utilities so existing `bg-gray-*`, `text-gray-*`,
and border utilities remain theme-aware. New UI should continue using the documented primitives
and Tailwind gray scale rather than adding light-only hex colors. Browser-local preference state is
owned by `frontend/src/store/themeStore.js`; it does not sync with user documents.

---

## 1) Contracts

| Contract | Rule |
|---|---|
| **Radius** | Controls (buttons, inputs, selects, badges, table cells' images) use `rounded-md`. Containers (modals, cards, sections, tables, dropzones, menus) use `rounded-lg`. Pills and avatars use `rounded-full`. Bare `rounded` is not used. |
| **Accent** | `gray-800` / `gray-900`. Blue is reserved for hyperlinks only — never for primary buttons, selection states, focus rings or progress. |
| **Borders** | `border-gray-300` on interactive controls, `border-gray-200` on structural dividers and container edges. |
| **Focus** | Buttons: `focus-visible:ring-2 ring-gray-500 ring-offset-2`. Inputs: `focus:ring-1 ring-gray-500` plus `focus:border-gray-500`. |
| **Icon spacing** | Layout by `gap`, never by margins on the icon. Icons in buttons are `h-4 w-4`. |
| **Disabled** | `opacity-50` + `cursor-not-allowed`. Never a separate background colour. |

### Type scale

| Class | Use |
|---|---|
| `pn-title-page` | `text-xl font-semibold text-gray-900` — page/nav title |
| `pn-title-modal` | `text-lg font-semibold text-gray-900` — dialog title, page section heading |
| `pn-title-section` | `text-base font-semibold text-gray-900` — section inside a dialog |
| `pn-title-sub` | `text-sm font-semibold text-gray-900` — sub-group label |
| `pn-body` | `text-sm text-gray-600` — descriptive copy |
| `pn-meta` | `text-xs text-gray-500` — timestamps, counts, hints |

---

## 2) Components

### `BaseModal.vue`

The only dialog chrome. Supplies overlay, panel, header (title + optional subtitle +
close button), a scrolling body and a sticky footer. Callers never write their own
overlay, padding or close affordance.

```vue
<BaseModal
    :show="show"
    title="Export Data"
    size="md"
    close-testid="export-modal-close-button"
    @close="$emit('close')"
>
    …body…
    <template #footer>
        <BaseButton variant="secondary" size="md" @click="$emit('close')">Done</BaseButton>
    </template>
</BaseModal>
```

`size`: `sm` 480px · `md` 600px · `lg` 720px. Pick by how much content there is, not by
how important the dialog is. Pass `:close-on-backdrop="false"` when a stray click outside
would lose work.

Parent components can still set `data-testid` on the `<BaseModal>` element — it falls
through to the dialog root.

### `BaseButton.vue`

| `variant` | Use |
|---|---|
| `primary` | One per view: the action the user came to perform. |
| `secondary` | The paired escape hatch — Cancel, Back, Done, Close. |
| `ghost` (default) | Toolbar and table-row actions; no chrome until hover. |
| `danger` | Destructive. Same weight as `ghost` on purpose, so it sits in a table row without out-shouting its neighbours. |

`size`: `md` (`px-4 py-2`) for dialog and form actions, `sm` (`px-3 py-1.5`, default) for
toolbars and table rows. `icon-only` gives square padding. `is-active` renders the pressed
state for toolbar toggles.

### `PromptModal.vue`

Single-field name prompt (create document, create folder, rename). Owns its own focus.

### `OptionCard.vue`

The large "pick a format" row used by Import and Export. The icon sits in a fixed box
aligned to the title's first line, so a one-line and a three-line option read as the same
component.

---

## 3) CSS primitives

Form controls: `pn-label`, `pn-label-optional`, `pn-input`, `pn-select`, `pn-textarea`,
`pn-input-error`, `pn-checkbox`, `pn-radio`, `pn-help`, `pn-field-error`.

Surfaces: `pn-panel` (white card), `pn-panel-muted` (gray-50 inset), `pn-divider`.

Alerts: `pn-alert` plus one of `pn-alert-error` / `pn-alert-warning` /
`pn-alert-success` / `pn-alert-info`.

Tables: `pn-table-wrap` on the scroll container, `pn-table` on the `<table>` — it styles
`thead`, `th`, `tbody` and `td` descendants, so cells need no classes of their own.
`pn-table-empty` for the empty/loading row.

Editor toolbar: `pn-toolbar-button` (+ `pn-toolbar-button-tight`), `pn-toolbar-input`.

> **`@tailwindcss/forms` is not installed.** Native checkboxes and radios ignore
> `text-*`; `accent-*` is what recolours them. That is why `pn-checkbox` / `pn-radio`
> use `accent-gray-800`. Reintroducing a `text-*` accent on a native control is a no-op.

---

## 4) Copy conventions for dialog footers

- A dialog whose body is a set of terminal actions or a manager (Export, Global Variables,
  GitHub Backup) closes with a single **Done**.
- A dialog with one pending action (Import, Image Library, Template Picker, prompts) uses
  **Cancel** + the primary verb.
- Never mix Done / Close / Cancel for the same role across dialogs.

---

## 5) Known follow-ups

- `frontend/src/style.css` is unused Vite scaffold (it is not imported anywhere; only
  `assets/main.css` is). It contains a global `button { border-radius: 8px; background-color: #1a1a1a }`
  that would fight this system if it were ever imported. Safe to delete.
- `TemplateManagerPage`'s action column can overflow its card below ~1100px. The table
  scrolls (`pn-table-wrap`), so it is usable, but the column set is dense.

## 6) Identity palette

Colour is also used for **people**. That is a deliberate, documented exception to the
Accent contract in §1, carved out by [COLLAB-03](../../specs/proposed/collab-03-identity-palette.md).

1. Identity colours identify **people only** — avatars, presence dots, attribution marks,
   remote selection tints.
2. They are never used for a control, a state, a focus ring, progress, or a severity. Those
   remain `gray-800`/`gray-900` and the `pn-alert-*` variants.
3. They are never the sole carrier of meaning. Always paired with initials or a name.
4. They are hard-coded hex, deliberately not remapped in dark mode — a person is the same
   colour in both themes.
5. New identity colours must pass the COLLAB-03 §3 thresholds against both surfaces and be
   checked against `--pn-primary` and `--pn-accent` for confusability. Run
   `node scripts/verify-identity-palette.cjs` to verify.

The palette lives in `frontend/src/utils/identityColor.js`; the avatar primitives are
`UserAvatar.vue` and `AvatarStack.vue`. Presence status (online/idle/offline) uses gray tones,
not the identity palette.
