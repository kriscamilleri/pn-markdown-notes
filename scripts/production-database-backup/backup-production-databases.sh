#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

# Resolve defaults relative to this checkout so the script works from any directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PRODUCER="$SCRIPT_DIR/stream-database-backup.mjs"
ENV_FILE="${PANINO_PROD_ENV_FILE:-$REPO_ROOT/prd-server.env}"
OUTPUT_DIR="${PANINO_BACKUP_DIR:-$HOME/backups/panino}"
LIST_ONLY=0
INCLUDE_DATABASES="${PANINO_BACKUP_INCLUDE:-}"
EXCLUDE_DATABASES="${PANINO_BACKUP_EXCLUDE:-}"

usage() {
  cat <<'EOF'
Usage: scripts/production-database-backup/backup-production-databases.sh [options]

Stream consistent snapshots of all production SQLite databases into a local archive.
Each online snapshot temporarily uses /dev/shm (RAM-backed storage), never remote disk.

Options:
  --env-file PATH    Credential environment file (default: ./prd-server.env)
  --output-dir PATH  Local backup directory (default: ~/backups/panino)
  --list             List databases and sizes, copy nothing, then exit
  --only NAMES       Comma-separated database filenames to include (default: all)
  --exclude NAMES    Comma-separated database filenames to skip (default: none)
  -h, --help         Show this help

A full backup takes every database and that is the default. --only exists for narrow
diagnostic pulls that have no business copying the whole estate onto a workstation, e.g.

  --only <user-id> --exclude _users.db

Names may omit the .db suffix. Path separators are rejected.

Environment file variables:
  PANINO_PROD_HOST, PANINO_PROD_USER, PANINO_PROD_PASSWORD,
  PANINO_REMOTE_APP_DIR

The existing IP, UN, and P variable names are also supported for compatibility.
Optional: PANINO_PROD_PORT (default: 22).
EOF
}

while (($# > 0)); do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || { echo "Missing value for --env-file" >&2; exit 2; }
      ENV_FILE="$2"
      shift 2
      ;;
    --output-dir)
      [[ $# -ge 2 ]] || { echo "Missing value for --output-dir" >&2; exit 2; }
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --list)
      LIST_ONLY=1
      shift 1
      ;;
    --only)
      [[ $# -ge 2 ]] || { echo "Missing value for --only" >&2; exit 2; }
      INCLUDE_DATABASES="$2"
      shift 2
      ;;
    --exclude)
      [[ $# -ge 2 ]] || { echo "Missing value for --exclude" >&2; exit 2; }
      EXCLUDE_DATABASES="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -r "$PRODUCER" ]] || {
  echo "Backup producer not found: $PRODUCER" >&2
  exit 1
}

# Credentials stay in the ignored machine-local env file rather than command arguments.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

SSH_HOST="${PANINO_PROD_HOST:-${IP:-}}"
SSH_USER="${PANINO_PROD_USER:-${UN:-}}"
SSH_PASSWORD="${PANINO_PROD_PASSWORD:-${P:-}}"
SSH_PORT="${PANINO_PROD_PORT:-22}"
REMOTE_APP_DIR="${PANINO_REMOTE_APP_DIR:-}"

[[ -n "$SSH_HOST" ]] || {
  echo "Missing PANINO_PROD_HOST (or IP) in the environment" >&2
  exit 1
}
[[ -n "$SSH_USER" ]] || {
  echo "Missing PANINO_PROD_USER (or UN) in the environment" >&2
  exit 1
}
[[ -n "$REMOTE_APP_DIR" ]] || {
  echo "Missing PANINO_REMOTE_APP_DIR in the environment" >&2
  exit 1
}
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] || {
  echo "PANINO_PROD_PORT must be numeric" >&2
  exit 1
}

# Keep SSH non-interactive and fail stalled transfers instead of leaving a partial run.
ssh_command=(
  ssh
  -p "$SSH_PORT"
  -o ConnectTimeout=15
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -o StrictHostKeyChecking=accept-new
)

if [[ -n "$SSH_PASSWORD" ]]; then
  command -v sshpass >/dev/null 2>&1 || {
    echo "sshpass is required when a production SSH password is configured" >&2
    exit 1
  }
  export SSHPASS="$SSH_PASSWORD"
  ssh_command=(sshpass -e "${ssh_command[@]}")
else
  ssh_command+=(-o BatchMode=yes)
fi

printf -v remote_app_dir_list_q "%q" "${PANINO_REMOTE_APP_DIR:-}"

# --list returns metadata only — names, sizes, mtimes — and copies no database content. It
# exists because --only needs discoverable names, and the alternative is an ad-hoc `ls`
# inside the production container, which reaches into a directory AGENTS.md §3 marks
# do-not-read. Short-circuits before any archive machinery is set up.
if [[ "$LIST_ONLY" -eq 1 ]]; then
  list_command="cd $remote_app_dir_list_q && \
container=\$(docker compose ps -q api-service) && \
if [ -z \"\$container\" ]; then \
  echo 'Production api-service container is not running' >&2; exit 1; \
fi && \
docker exec -i \
  -e PANINO_STREAM_BACKUP_RUN=1 \
  -e PANINO_BACKUP_LIST=1 \
  -e DB_DIR=/app/backend/api-service/data \
  \"\$container\" node --input-type=module -"

  "${ssh_command[@]}" "$SSH_USER@$SSH_HOST" "$list_command" < "$PRODUCER"
  unset SSHPASS SSH_PASSWORD P PANINO_PROD_PASSWORD
  exit 0
fi

# Build into process-specific temporary names. Cleanup removes every incomplete artifact.
mkdir -p -- "$OUTPUT_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive_name="panino-databases-$timestamp.tar.gz"
archive_path="$OUTPUT_DIR/$archive_name"
partial_path="$archive_path.part.$$"
checksum_path="$archive_path.sha256"
checksum_partial_path="$checksum_path.part.$$"
backup_complete=0

[[ ! -e "$archive_path" && ! -e "$checksum_path" ]] || {
  echo "Refusing to overwrite an existing backup artifact for $archive_path" >&2
  exit 1
}

cleanup() {
  rm -f -- "$partial_path" "$checksum_partial_path"
  if [[ "$backup_complete" -eq 0 ]]; then
    rm -f -- "$archive_path" "$checksum_path"
  fi
  unset SSHPASS SSH_PASSWORD P PANINO_PROD_PASSWORD
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Quote the configurable remote path before embedding it in the remote shell command.
# The producer is piped to Node over stdin; archive bytes return on stdout while progress
# remains on stderr. Each temporary SQLite snapshot lives only in RAM-backed /dev/shm.
printf -v remote_app_dir_q "%q" "$REMOTE_APP_DIR"

# Selection is passed as environment rather than argv: the producer arrives on stdin and has
# no argument vector of its own. Both values are quoted for the remote shell.
selection_env=""
if [[ -n "$INCLUDE_DATABASES" ]]; then
  printf -v include_q "%q" "$INCLUDE_DATABASES"
  selection_env+=" -e PANINO_BACKUP_INCLUDE=$include_q"
fi
if [[ -n "$EXCLUDE_DATABASES" ]]; then
  printf -v exclude_q "%q" "$EXCLUDE_DATABASES"
  selection_env+=" -e PANINO_BACKUP_EXCLUDE=$exclude_q"
fi

remote_command="cd $remote_app_dir_q && \
container=\$(docker compose ps -q api-service) && \
if [ -z \"\$container\" ]; then \
  echo 'Production api-service container is not running' >&2; exit 1; \
fi && \
docker exec -i \
  -e PANINO_STREAM_BACKUP_RUN=1 \
  -e DB_DIR=/app/backend/api-service/data \
  -e UPLOADS_DIR=/app/backend/api-service/uploads \
  -e PANINO_BACKUP_TMP_DIR=/dev/shm \
  -e PANINO_BACKUP_PROGRESS=1$selection_env \
  \"\$container\" node --input-type=module -"

echo "Streaming production databases to $archive_path ..."
if ! "${ssh_command[@]}" "$SSH_USER@$SSH_HOST" "$remote_command" \
  < "$PRODUCER" > "$partial_path"; then
  echo "Database backup stream failed; partial archive removed" >&2
  exit 1
fi

# Validate both compression and expected archive contents before publishing final filenames.
gzip -t -- "$partial_path" || {
  echo "Received archive failed gzip validation" >&2
  exit 1
}

database_count="$(
  tar -tzf "$partial_path" |
    awk '/^data\/(spaces\/)?[^/]+\.db$/ { count += 1 } END { print count + 0 }'
)"
[[ "$database_count" -gt 0 ]] || {
  echo "Received archive contains no database snapshots" >&2
  exit 1
}

tar -tzf "$partial_path" |
  awk '$0 == "panino-backup-manifest.json" { found = 1 } END { exit !found }' || {
  echo "Received archive contains no production backup manifest" >&2
  exit 1
}

# Generate the checksum first, then publish the archive and checksum with atomic renames.
checksum_value="$(sha256sum "$partial_path" | awk '{ print $1 }')"
printf '%s  %s\n' "$checksum_value" "$archive_name" > "$checksum_partial_path"
mv -- "$partial_path" "$archive_path"
mv -- "$checksum_partial_path" "$checksum_path"
backup_complete=1
trap - EXIT HUP INT TERM
unset SSHPASS SSH_PASSWORD P PANINO_PROD_PASSWORD

echo "Backup complete: $archive_path ($database_count databases)"
echo "Checksum: $checksum_path"
