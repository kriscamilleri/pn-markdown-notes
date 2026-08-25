# COLLAB-05 mandatory editor/CRDT spike

- **Agent:** Codex
- **Started:** 2026-08-18 22:54 +0200
- **Status:** Complete — both gates passed

## Objective

Run the mandatory disposable COLLAB-05 §6.1a feasibility gate before scheduling production live
sessions: bind two OverType textareas to one `Y.Text` without whole-document replacement and prove
that an acknowledged recovery snapshot survives a server crash while an unacknowledged update is
replayed by the client.

## Progress

- Added Yjs as a frontend development-only spike dependency; no production module imports it yet.
- Instantiated two real OverType editors under jsdom and attached a disposable textarea binding.
- Spawned a disposable child-process recovery server and forced `SIGKILL` between applying an
  update in memory and persisting/acknowledging it.
- Both acceptance gates passed, so COLLAB-05 production implementation may proceed.

## Changes Made

- The binding uses a common-prefix/common-suffix scan and one contiguous Yjs delete/insert
  transaction. It suspends input during composition, applies a paste as one transaction,
  transforms both selection endpoints through remote deltas, and scopes undo by stable local
  origin.
- The recovery worker stores the full Yjs update and durable sequence through file fsync, atomic
  rename, and directory fsync before emitting an acknowledgement. Duplicate durable sequences are
  acknowledged without being applied twice.

## Tests

- `npm test --prefix frontend -- --run tests/spike/collab05BindingSpike.test.js
  tests/spike/collab05DurabilitySpike.test.js` — passed, 2 files / 3 tests.
- Binding coverage: insert, replacement, single-transaction large paste, IME composition gate,
  remote selection transformation, participant-scoped undo, and no whole-body delete+insert.
- Durability coverage: acknowledged sequence 1 survives `SIGKILL`; deliberately unacknowledged
  sequence 2 is absent after restart, then replays and becomes durable; duplicate sequence 2 is
  idempotent.

## Open Items / Notes

- `npm install` reported four pre-existing dependency audit findings (two moderate, one high, one
  critical); no breaking `npm audit fix --force` was run.
- The spike is deliberately outside `frontend/src/`. Production live sessions remain online-only,
  explicit opt-in, space-scoped, crash-recoverable, and commit plain text through normal sync.
