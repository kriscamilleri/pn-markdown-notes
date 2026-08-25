# Deployment runbook

## Before deploying

1. Confirm the branch has passed the frontend and backend CI checks.
2. Confirm the server checkout is clean. The deploy workflow performs this check before
   running `git pull`.
3. Confirm the required GitHub secrets (`SSH_PRIVATE_KEY`, `SSH_USER`, `SSH_HOST`,
   `PROJECT_PATH`) are present.

## What `deploy.sh` does

From the repository root, `deploy.sh`:

1. Loads deployment configuration from `.env`.
2. Builds the frontend and writes its production environment file.
3. Generates and, when running as root, installs the Nginx configuration.
4. Starts the production `api-service` container with Docker Compose.

The production compose file mounts `api-data` at `/app/backend/api-service/data` and
`uploads-data` at `/app/backend/api-service/uploads`. Those directories are runtime volumes
and must not be copied into image layers. Operator tooling must use these mounted paths;
`/app/data` and `/app/uploads` are not the production volumes.

## Collaboration feature flags

Both collaboration gates default to false in Compose:

```text
SHARED_SPACES_ENABLED=false
LIVE_SESSIONS_ENABLED=false
```

Live sessions also require shared spaces. Enable them only after a full backup and the isolated
two-account checks in `live-session-recovery.md`. Turning off the live flag rejects new sessions;
sessions already held by the process remain eligible to reconnect and save while they drain.
Recovery rows are never deleted just because the flag is off.

## Stream a production database backup

Run the backup from a trusted local checkout:

```bash
./scripts/production-database-backup/backup-production-databases.sh
```

By default, the script reads the ignored `prd-server.env` file and writes
`~/backups/panino/panino-databases-<UTC timestamp>.tar.gz` plus a SHA-256 checksum.
Use `--env-file` or `--output-dir` to override either path. The preferred credential names
are `PANINO_PROD_HOST`, `PANINO_PROD_USER`, and `PANINO_PROD_PASSWORD`; the existing `IP`,
`UN`, and `P` names remain supported.

The API stays online. Inside the running container, SQLite's online backup API creates one
transactionally consistent database snapshot at a time in `/dev/shm`, streams it into the
gzip-compressed tar archive, and removes it immediately. No snapshot is written to remote
disk. The container's RAM-backed `/dev/shm` must have enough free capacity for the largest
database. If it does not, the command fails, removes the local `.part` archive, and reports
the required and available byte counts.

During the run, stderr shows each database or space upload's snapshot/transfer progress and
completion. Per-user and per-space identifiers are deliberately replaced with ordinal labels;
the authentication and shared-space metadata databases are identified by role.

The archive contains a versioned, hashed path manifest and preserves the production layout:
`data/_spaces.db`, every `data/spaces/<spaceId>.db`, `uploads/spaces/<spaceId>/`, personal
databases, and `data/_users.db`. SQLite files use the online backup API. Space uploads are
streamed as regular files; if a file changes while it is read, or a symlink/non-UUID space
root is encountered, the backup fails and its partial local artifact is removed.

Before relying on an archive, verify it locally:

```bash
cd ~/backups/panino
sha256sum -c panino-databases-<UTC timestamp>.tar.gz.sha256
tar -tzf panino-databases-<UTC timestamp>.tar.gz
```

Do not extract an archive over the production volume. Stage and validate it with:

```bash
node scripts/production-database-backup/stage-production-restore.mjs \
  --archive ~/backups/panino/panino-databases-<UTC timestamp>.tar.gz \
  --staging-dir /srv/panino-restore/<UTC timestamp>
```

The command verifies the companion SHA-256 file before extraction; rejects absolute,
traversing, duplicate, unmanifested, and unsupported paths; checks every manifest digest;
runs `PRAGMA integrity_check` on every database; runs `assertSpacesInvariants()` against the
staged auth and space metadata databases; verifies every shared image row has matching bytes;
and requires the metadata space ids, space database files, and upload roots to agree. A selected `--only`/`--exclude` diagnostic archive is not a
full restore and is rejected. On failure, the temporary staging tree is removed; live data is
never touched.

## Restore maintenance window

A restore changes production state and requires explicit approval in the current incident,
a fresh timestamped backup, and an agent log. Keep `SHARED_SPACES_ENABLED=false` until the
drill and application release are approved.

1. Run the staging command above on the target host and record its reported snapshot time,
   entry count, and space count. Never edit the staged set after validation.
2. Resolve the exact `api-data` and `uploads-data` mountpoints with read-only Docker Compose
   inspection. Do not assume a host path and do not operate on a broad directory or unresolved
   variable.
3. Stop `api-service` so no database, membership, or upload can change. Take a second backup
   and verify its checksum; this is the rollback point.
4. Install the staged `data/` and `uploads/` trees as one maintenance operation, retaining the
   complete previous pair under timestamped rollback names. Never restore `_spaces.db`, a
   space database, or a space upload directory individually.
5. Before admitting traffic, rerun the read-only validator against the installed pair with
   `stage-production-restore.mjs --verify-dir <installed-root>`. If any manifest, SQLite,
   invariant, or set-agreement check fails, keep the API stopped and restore the complete
   rollback pair.
6. Start `api-service` only after the whole set passes. With the shared-spaces flag still
   disabled, verify personal login/sync first; then perform the separately approved,
   flag-enabled two-account space drill and confirm membership, content, and images all load.
7. Retain both the source archive and rollback pair until the recovery is signed off.

Because SQLite online backup is per database, the archive is a bounded sequence rather than a
cross-file filesystem snapshot. Traffic gating makes restore admission all-or-nothing;
membership versions force client refresh, and CR-SQLite converges slightly stale complete
content after service resumes. See the fixed contract in
[`docs/specs/proposed/collab-04-phase-0-design-artifacts.md`](../specs/proposed/collab-04-phase-0-design-artifacts.md) §5.

## Routing

- `/` serves the built frontend from Nginx.
- `/api/*` proxies to the backend with the `/api` prefix stripped.
- `/ws/*` proxies WebSocket upgrades to the backend.

## Failure handling

If the server checkout is dirty, stop and inspect the named files before changing anything.
Do not discard server changes automatically. If a deploy fails after the pre-flight check,
inspect the workflow output and the server's Docker/Nginx logs before retrying.

For production debugging or a manual recovery, load the `prod-server-debug` skill and follow
its read-only-first rule.
