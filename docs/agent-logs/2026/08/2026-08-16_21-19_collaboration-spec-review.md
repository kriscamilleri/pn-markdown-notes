# Collaboration Specification Review

Agent: Copilot CLI
Start: 2026-08-16 21:19 +02:00
Status: complete (final-review revisions applied)

## Objective

Review the proposed collaboration specifications for incorrect assumptions, missing requirements,
and areas requiring expansion before implementation begins.

## Progress

Read COLLAB-00 through COLLAB-05 and checked their key assumptions against the current CR-SQLite
sync contract, frontend database lifecycle, backend connection cache, WebSocket implementation,
revision handling, image routes, and production deployment model.

## Changes Made

No product code changed. The review findings were incorporated into COLLAB-00, COLLAB-02,
COLLAB-03, COLLAB-04 and COLLAB-05: owner/editor-only v1 roles, server-derived attribution,
upgrade-safe merges, explicit merge re-sync, testable palette rules, resumable transfers, resource
limits, and acknowledged session recovery. A final pass added a canonical shared merge module,
space sync table/column allowlisting, client compatibility floors, backup/restore scope,
membership-email lifecycle rules, session/sync handoff semantics, recovery retention, and
operational metrics/alerts. The overview now ends with a three-collaborator end-to-end acceptance
exercise covering space transfer, ordinary sync/merge, image replication, live collaboration,
offline clock-based catch-up and crash recovery.

A final adversarial handoff review then identified three blockers and twelve high/medium contract
gaps. The spec set now also defines:

- the installable `@panino/content-merge` package, Docker build context and shared test ownership;
- one versioned WebSocket envelope with atomic subscription, revocation, limits and backpressure;
- space-only eager `collab_sessions` migration and bounded shutdown/commit ordering;
- transactional sync-time merge classification, fail-closed write-back capability and local-table
  import/export exclusion;
- exact content normalization/SHA-256 hashing, circuit-breaker reset and editor watcher ordering;
- per-user membership versions, owner uniqueness, strict table/column sync allowlisting and online
  revocation;
- Markdown-aware cross-database image rewriting and advisory local storage behavior; and
- participant limits, timer ownership, direct collaborative revision creation and compatibility/
  rollback handoff gates.

## Tests

No runtime tests apply to documentation-only work. Checked the revised specifications for stale
viewer-role, merge-module-path, base-version, startup-only-revocation and site-id-attribution
contracts; checked whitespace and relative Markdown links. The original adversarial reviewer
re-reviewed all prior B1-B3, H1-H5, M1-M7 and L1-L5 findings after the edits and returned `READY`
with no new contradictions or infeasible requirements.

## Open Items / Notes

The spec set is ready for implementation handoff. Implementation must follow the dependency-ordered
gates in COLLAB-00 and retain the listed automated, browser, compatibility and operations evidence.
