# Production backup and staged restore

Streams transactionally consistent snapshots of every production SQLite database directly
to the local machine, together with the shared-space upload tree. The API remains online,
and no backup is written to remote disk.

## Run

From the repository root:

```bash
./scripts/production-database-backup/backup-production-databases.sh
```

The default output is:

```text
~/backups/panino/panino-databases-<UTC timestamp>.tar.gz
~/backups/panino/panino-databases-<UTC timestamp>.tar.gz.sha256
```

Use a different credential file or destination with:

```bash
./scripts/production-database-backup/backup-production-databases.sh \
  --env-file /path/to/production.env \
  --output-dir /path/to/backups
```

## Requirements

- Bash, OpenSSH, gzip, tar, awk, and sha256sum on the local machine.
- `sshpass` when password authentication is configured.
- Docker Compose and a running `api-service` container on production.
- Enough free space in the container's RAM-backed `/dev/shm` for the largest database.

The ignored environment file defaults to `prd-server.env` at the repository root:

```bash
PANINO_PROD_HOST=production-host
PANINO_PROD_USER=production-user
PANINO_PROD_PASSWORD=production-password
PANINO_REMOTE_APP_DIR=/private/production/checkout
```

Legacy `IP`, `UN`, and `P` names are also accepted. Optional settings are
`PANINO_PROD_PORT`, `PANINO_PROD_ENV_FILE`, and `PANINO_BACKUP_DIR`.

## Backup contents and ordering

The versioned manifest maps every archive entry to its restore path and records its size and
SHA-256 digest. A full archive is ordered as follows:

1. `data/_spaces.db`;
2. `data/spaces/<space-id>.db` databases;
3. `uploads/spaces/<space-id>/...` assets;
4. personal `data/<user-id>.db` databases;
5. `data/_users.db`;
6. `panino-backup-manifest.json`.

Space database names and upload roots must be UUIDs. Symlinks, non-regular upload entries,
path escapes, duplicate paths, and archive paths outside the three documented prefixes fail
closed. `--only` and `--exclude` remain diagnostic conveniences; archives made with either
option are marked `selected` and the restore tool refuses to treat them as a full estate.

## How backup works

1. The Bash script opens a non-interactive SSH connection to production.
2. It pipes `stream-database-backup.mjs` into Node inside the running API container.
3. The Node producer uses SQLite's online backup API to snapshot one database at a time into
   `/dev/shm`.
4. It streams space uploads and a hashed path manifest into the same gzip-compressed tar,
   writing progress only to stderr.
5. SSH carries stdout directly into a local `.part` file.
6. The Bash script validates the archive, writes its checksum, and atomically publishes both
   final files.

Per-user database filenames are hidden from progress output. The temporary snapshot and local
partial files are removed if any stage fails.

## Verify and stage a restore

```bash
cd ~/backups/panino
sha256sum -c panino-databases-<UTC timestamp>.tar.gz.sha256
tar -tzf panino-databases-<UTC timestamp>.tar.gz
```

Then use the reviewed staging command from a checkout with backend dependencies installed:

```bash
node scripts/production-database-backup/stage-production-restore.mjs \
  --archive ~/backups/panino/panino-databases-<UTC timestamp>.tar.gz \
  --staging-dir /srv/panino-restore/<UTC timestamp>
```

The command verifies the companion checksum, validates every manifest hash and path, runs
`PRAGMA integrity_check` on every SQLite database, runs `assertSpacesInvariants()` against
the staged `_spaces.db` and `_users.db`, verifies every space image row has matching bytes,
and verifies that metadata, every space database, and every space upload root are one complete
set. It writes through a private temporary
directory and publishes the requested staging directory only after every check passes.

Recheck an already staged or installed pair without changing it:

```bash
node scripts/production-database-backup/stage-production-restore.mjs \
  --verify-dir /srv/panino-restore/<UTC timestamp>
```

The staging command never changes live data. Do not extract directly over Docker volumes and
do not copy individual space files from a staged set. Follow the deployment runbook for the
approved maintenance-window swap and rollback procedure.
