# COLLAB-01 — Editor Conflict Safety

> Stop the open editor from silently destroying remote edits. Fixes an active data-loss bug.
> Status: proposed
> Created: 2026-08-16
> Last updated: 2026-08-16 (final review)
> Part of [COLLAB-00](collab-00-overview.md)

---

## 1) Summary

A remote edit to the document currently open in the editor is never shown to the user and is
destroyed by their next keystroke. This affects **one user with two devices today** — it needs no
collaboration feature to reproduce. CR-SQLite is not involved; the loss happens above it.

This spec makes the editor aware that its document changed underneath it, and stops it writing
over content it never displayed.

---

## 2) The bug

The path, in order:

1. Sync merges a remote change and calls `useDocStore().refreshData()`
   ([syncStore.js:778](../../../frontend/src/store/syncStore.js#L778)).
2. `refreshData` calls `structureStore.reFetchSelectedFile()`
   ([docStore.js:44-52](../../../frontend/src/store/docStore.js#L44-L52)), which replaces
   `selectedFile.value` with the merged row
   ([structureStore.js:61-70](../../../frontend/src/store/structureStore.js#L61-L70)).
3. The editor's content watch is keyed on `file.value?.id`
   ([Editor.vue:430](../../../frontend/src/components/Editor.vue#L430)). The id did not change, so
   `setValue` never runs. **The editor still displays the stale local text, with no indication
   anything happened.**
4. The next keystroke calls `handleInput`
   ([Editor.vue:298-310](../../../frontend/src/components/Editor.vue#L298-L310)), which schedules
   `debouncedSyncToDB` at 500ms
   ([Editor.vue:168-170](../../../frontend/src/components/Editor.vue#L168-L170)).
5. That runs `docStore.updateFileContent`, a full-body
   `UPDATE notes SET content = ?` ([docStore.js:176-196](../../../frontend/src/store/docStore.js#L176-L196)).

The remote edit is gone. It survives in backend `note_revisions`, so it is *recoverable* by a user
who knows to look — but nothing tells them to look.

### Reproduction

1. Log in on two browsers, A and B, with sync enabled.
2. Open the same document in both.
3. In B, type a sentence. Wait for sync (or for the WebSocket poke to reach A).
4. In A, observe the editor still shows the old text.
5. In A, type one character.
6. Both A and B converge on A's text. B's sentence is gone from the document.

### Secondary finding

`docStore.isSaving` is set, and given a deliberate 300ms floor so the state is visible
([docStore.js:176-196](../../../frontend/src/store/docStore.js#L176-L196)), but **no `.vue` file
reads it**. The editor currently gives no persistence feedback at all. This spec adds the first
such surface.

---

## 3) Goals

1. A remote change to the open document never disappears without the user seeing it.
2. When the editor has no unsaved local changes, remote content is adopted automatically without a
   blocking prompt or notification.
3. When it does, the user chooses, and both versions remain reachable until they do.
4. The editor gains a persistence/dirty indicator.

## Non-goals

- No automatic merging. That is [COLLAB-02](collab-02-content-merge.md); this spec only detects
  and prompts.
- No changes to `sync.js`, `db.js`, or any CRR schema.
- No presence, no realtime, no sharing.

---

## 4) Design

### 4.1 Track the base

The editor needs to distinguish "content I have seen and am editing from" (**base**) from "content
now in the database" (**theirs**) and "content in my textarea" (**mine**).

Add to `draftStore` a per-document base alongside the existing draft:

```js
// frontend/src/store/draftStore.js
const bases = ref({})              // fileId => string
function getBase(fileId) { … }
function setBase(fileId, text) { … }
function clearBase(fileId) { … }
```

The base is set when a document is opened or when remote content is adopted. It is **in-memory
only** in this spec — on reload, the editor loads from the database, so base and theirs agree by
construction. [COLLAB-02](collab-02-content-merge.md) promotes it to a durable table because
merging an offline edit made hours ago requires a base that survives a reload. That promotion is
anticipated, not a surprise.

### 4.2 Classify on refresh

`reFetchSelectedFile` gains a callback, or the editor watches `file.value?.content` in addition to
`.id`. Prefer the latter — it is local to `Editor.vue` and does not widen the store's contract.
Implement this as one ordered watch over `[file.value?.id, file.value?.content]`, not two independent
watchers:

1. If the id changed, cancel the old document's debounce, clear its conflict state, initialize the
   editor/draft/base for the new id exactly once, and return without running same-document
   classification.
2. If the id is unchanged and content changed, run the table below.

Programmatic adoption/resolution sets an editor-local guard around `setValue`; the resulting reactive
notification may refresh bookkeeping but must not re-enter classification or schedule a database
write. This ordering is required because `reFetchSelectedFile` replaces the whole selected object
even when its id is unchanged.

On a content change for the same document id:

| Condition | Behaviour |
|---|---|
| `mine === base` (editor clean) | Adopt: `setValue(theirs)`, update base and draft. No prompt. |
| `mine !== base`, `theirs === base` | Nothing happened remotely. Ignore. |
| `mine !== base`, `theirs !== base` | **Diverged.** Enter conflict state (§4.3). |

Comparison uses `hasDocumentContentChanged`
([documentPersistence.js](../../../frontend/src/utils/documentPersistence.js)), which already
normalizes legacy `null` content to `""`.

Adoption must preserve the cursor. `setValue` on OverType resets selection, so capture
`selectionStart`/`selectionEnd` before and restore after. When the remote change is a pure
append below the cursor the offset is unchanged; otherwise clamp to the new length. Exact cursor
preservation across arbitrary remote edits is [COLLAB-02](collab-02-content-merge.md)'s problem.

### 4.3 Conflict state

While diverged:

- **`debouncedSyncToDB` is cancelled and suppressed.** This is the actual fix — no local write
  reaches the database until the user resolves. Keystrokes still update `contentDraft` and
  `draftStore`, so the user can keep typing and nothing they type is lost.
- A banner appears in the editor (§5).
- Resolution options:
  - **Keep mine** — write `mine` to the database, set base to `mine`, resume normal saving.
  - **Use theirs** — `setValue(theirs)`, set base and draft to `theirs`, resume.
  - **Compare** — open a read-only diff of `base → theirs` versus `base → mine`, using the
    `diffLines` rendering already present in
    [RevisionPanel.vue:94](../../../frontend/src/components/RevisionPanel.vue#L94). Reuse that
    surface; do not build a second comparison UI.

If a *further* remote change arrives while diverged, update `theirs` and leave the banner up.

### 4.4 Persistence indicator

Render `docStore.isSaving` and a new `isDirty` computed. Three states in one small surface near
the editor's stats bar:

- **Saved** — `pn-meta`, low emphasis, or absent entirely after a delay.
- **Saving…** — while `isSaving`.
- **Unsaved changes** — draft differs from base and no save is scheduled (i.e. suppressed by
  conflict state).

Follow the type scale in [ui-design-system.md §1](../../architecture/ui-design-system.md); this is
`pn-meta` territory, not a badge.

---

## 5) UI

A single banner inside the editor column, above the OverType container, so it does not fight the
global `OfflineIndicator` fixed banner
([OfflineIndicator.vue](../../../frontend/src/components/OfflineIndicator.vue), `top-0 z-50`).

Use `pn-alert pn-alert-warning`. Copy:

> **This document was updated elsewhere.** Your unsaved changes are being held.
> [Keep mine] [Use theirs] [Compare]

Buttons are `BaseButton` `size="sm"`; **Compare** is `ghost`, the two resolutions are `secondary`.
Deliberately no `primary` — neither choice is the one we recommend.

Per [ui-design-system.md §4](../../architecture/ui-design-system.md), the compare dialog is a
`BaseModal` with `:close-on-backdrop="false"`, since a stray click would drop the user back into an
unresolved conflict.

Terminology: **Document**, never "file", in all user-facing copy ([AGENTS.md §4](../../../AGENTS.md)).
Existing internal symbols such as `selectedFile` and `reFetchSelectedFile` are not renamed by this
spec; the terminology rule applies to rendered copy and accessibility labels.

Test ids: `editor-conflict-banner`, `editor-conflict-keep-mine`, `editor-conflict-use-theirs`,
`editor-conflict-compare`, `editor-save-status`.

Dark mode: verify at `html[data-theme="dark"]`. The last two dark-mode regressions in this repo
were both newly-introduced coloured surfaces (`ab0122b`, `9711727`); `pn-alert-warning` is exactly
that shape.

---

## 6) Files touched

| File | Change |
|---|---|
| `frontend/src/components/Editor.vue` | Content watch, conflict state, banner, save indicator, cursor preservation |
| `frontend/src/store/draftStore.js` | Base tracking alongside drafts |
| `frontend/src/store/docStore.js` | Expose `isDirty`; allow suppressing writes while diverged |
| `frontend/src/components/RevisionPanel.vue` | Extract the diff renderer for reuse (no behaviour change) |

No backend changes. No schema changes.

---

## 7) Tests

Frontend unit (`frontend/tests/unit/`, vitest + `@vue/test-utils`):

- `editorConflictSafety.test.js`
  - clean editor + remote change → adopts silently, base updated, no banner
  - dirty editor + remote change → banner, `updateFileContent` **not** called on subsequent input
  - dirty editor + no remote change → saves normally
  - keep-mine → writes local content, banner clears, saving resumes
  - use-theirs → editor shows remote content, local draft discarded, saving resumes
  - second remote change while diverged → banner persists, `theirs` updated
  - cursor position preserved across silent adoption
  - `null` persisted content treated as `""` (legacy documents)

Extend `frontend/tests/unit/documentPersistence.test.js` if the base comparison lands there.

Manual browser validation is required per [AGENTS.md §1](../../../AGENTS.md) — the repository has
no e2e harness, so run the §2 reproduction by hand against
`docker compose -f docker-compose.dev.yml up --build` and confirm it no longer loses data.

---

## 8) Risks

- **Adoption feels like the editor is possessed.** Text changing under the cursor can be surprising,
  but the clean case deliberately has no toast or modal: frequent remote saves would create
  notification noise. Cursor preservation and the normal save-status surface are the feedback.
- **Cursor restoration after `setValue`.** OverType owns the textarea and re-renders its preview
  layer; naive restoration will jump. Budget time for this specifically.
- **Conflict state must not survive document switching.** Clear it in the `file.value?.id` watch,
  or a stale banner will follow the user to the next document.
