# COLLAB-05 disposable binding and durability spike

This directory is acceptance evidence for COLLAB-05 §6.1a, not production session code.

- `yTextareaBinding.js` binds a plain OverType textarea to one `Y.Text` with a contiguous
  prefix/suffix edit, remote selection transformation, IME suspension, and an origin-scoped
  `Y.UndoManager`.
- `durableRecoveryWorker.js` is a disposable child-process server. It fsyncs and atomically
  renames a Yjs recovery snapshot before acknowledging a sequence. The test kills it with
  `SIGKILL` before a second update is durable, restarts it, and replays only that unacknowledged
  sequence.

Run both gates from the repository root:

```bash
npm test --prefix frontend -- --run \
  tests/spike/collab05BindingSpike.test.js \
  tests/spike/collab05DurabilitySpike.test.js
```

The production binding/session manager must be implemented separately and retain these regression
cases. Passing this spike does not make the disposable worker or binding a second source of truth.
