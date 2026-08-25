#!/usr/bin/env bash
# Canonical backend test runner. Uses the Node 24 image so results match production
# regardless of the host Node version. Pass extra arguments through to Vitest.
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE=panino-api-test
docker build -q -f backend/api-service/Dockerfile.test -t "$IMAGE" .

# tests/unit/stream-database-backup.test.js imports the producer relative to the
# repository root. The image preserves the backend's repository-relative path,
# so mount root scripts at the matching /app/scripts location.
docker run --rm -v "$PWD/scripts:/app/scripts:ro" "$IMAGE" npm test -- "$@"
