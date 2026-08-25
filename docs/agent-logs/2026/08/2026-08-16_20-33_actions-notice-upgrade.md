# GitHub Actions notice upgrade

Agent: Copilot CLI
Start: 2026-08-16 20:33 CEST
Status: Complete

## Objective

Upgrade the test workflow where supported to reduce notices emitted by GitHub Actions internals.

## Progress

- Confirmed that `actions/checkout` initializes the workspace with `git init`, which causes
  Git's default-branch advisory when no default is configured.
- Confirmed actions/checkout v5 is current and setup-node v7 is the current major release.

## Changes Made

- Set Git's command-scoped `init.defaultBranch` value to `main` at workflow level, so it is
  available before checkout starts.
- Upgraded both setup-node invocations from v5 to v7.

## Tests

- Workflow YAML inspected after the update.
- The new action versions and runner-level behavior require verification from the next GitHub
  Actions workflow run; no local command can execute GitHub-hosted actions.

## Open Items / Notes

- If Node deprecation notices remain after setup-node v7, they originate in GitHub's distributed
  action bundle and cannot be fixed in this repository.
