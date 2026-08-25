# Live-session recovery validation

Use an isolated stack with both collaboration flags explicitly enabled. Do not change the normal
development or production defaults.

1. Sign in as two members of one space, open the same Document, press **Collaborate** on both, and
   type interleaved text. Confirm both editors converge and the participant roster shows both.
2. After the sender's unsaved count returns to zero, kill only the API container. Restart it, wait
   for reconnect, and confirm the acknowledged text is restored before making another edit.
3. Repeat while an update is deliberately still unacknowledged. Confirm the client remains in
   **Reconnecting…**, replays the update after state exchange, and converges without duplication.
4. Press **Save version**. Confirm the ordinary Document syncs to both accounts, revision history
   names the saving member, and leaving the session restores solo saving.
5. Make an outside/offline edit during a session. Verify a non-overlapping save merges and an
   overlapping save opens the existing hunk resolver without changing the persisted body first.
6. Remove one member during a session and confirm their session becomes read-only/closed without
   exposing the space's existence. Request space deletion and confirm all sessions close at once.

For a deploy or restart, Docker grants the API 15 seconds. The process stops admission, attempts an
ordinary save, persists any recoverable failure, then exits. A nonzero/unflushed shutdown report is
not permission to delete recovery rows; restore service and let an authorized member reopen them.
