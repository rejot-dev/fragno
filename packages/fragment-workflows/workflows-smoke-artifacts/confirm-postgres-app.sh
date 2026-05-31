#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ARTIFACT_DIR="$ROOT_DIR/packages/fragment-workflows/workflows-smoke-artifacts"
RUN_ID="${WF_SMOKE_RUN_ID:-$(date +%Y%m%d_%H%M%S)_$RANDOM}"
POSTGRES_ADMIN_URL="${WF_POSTGRES_ADMIN_URL:-postgres://wilco@localhost:5436/postgres}"
DB_NAME="${WF_DATABASE_NAME:-fragno_wf_confirm_${RUN_ID}}"
APP_DATABASE_URL="${WF_EXAMPLE_DATABASE_URL:-postgres://wilco@localhost:5436/${DB_NAME}}"
PORT_VALUE="${PORT:-5173}"
BASE_URL_VALUE="${BASE_URL:-http://localhost:${PORT_VALUE}/api/workflows}"
LOG_FILE="${WF_CONFIRM_LOG_FILE:-${TMPDIR:-/tmp}/wf-example-confirm-${RUN_ID}.log}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-60}"
KEEP_DB_ON_SUCCESS="${KEEP_DB_ON_SUCCESS:-0}"

DEFAULT_SCRIPTS=(
  api-route-validation.js
  create-race.js
  load-concurrency.js
  load-parallel.js
  duplicate-event-idempotency.js
  history-pagination.js
  large-payload.js
  wait-timeout-edge.js
  terminate-race.js
  terminate-running-parallel.js
  scenario-matrix.js
  pause-event-race.js
  pause-resume-race.js
  clock-skew-retry.js
  clock-skew-timeout.js
  runner-tick-storm.js
  restart-event-race.js
  restart-fulfillment-leak.js
  restart-race.js
  auth-hook-concurrency.js
  retention-gc-check.js
)

SCRIPTS=("$@")
if [ "${#SCRIPTS[@]}" -eq 0 ]; then
  SCRIPTS=("${DEFAULT_SCRIPTS[@]}")
fi

APP_PID=""
DROP_DB=1

kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  local exit_code=$?
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    echo "Stopping wf-example dev server (pid $APP_PID)..."
    kill_tree "$APP_PID"
    wait "$APP_PID" 2>/dev/null || true
  fi

  if [ "$exit_code" -eq 0 ] && [ "$KEEP_DB_ON_SUCCESS" != "1" ] && [ "$DROP_DB" = "1" ]; then
    echo "Dropping temporary database $DB_NAME..."
    psql "$POSTGRES_ADMIN_URL" -v ON_ERROR_STOP=1 -c \
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$DB_NAME';" >/dev/null
    psql "$POSTGRES_ADMIN_URL" -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB_NAME\";" >/dev/null
  elif [ "$DROP_DB" = "1" ]; then
    echo "Keeping temporary database: $DB_NAME"
  fi

  if [ "$exit_code" -ne 0 ]; then
    echo
    echo "Confirmation failed. Useful log tail:"
    tail -n 80 "$LOG_FILE" 2>/dev/null || true
    echo
    echo "If you see 'Postgres.app failed to verify trust authentication', open Postgres.app -> Settings and allow the client app/process, then rerun this script."
  fi
}
trap cleanup EXIT

if [ -n "${WF_EXAMPLE_DATABASE_URL:-}" ]; then
  DROP_DB=0
fi

cat <<INFO
Confirming Postgres.app workflow smoke setup
  run id:       $RUN_ID
  admin url:    $POSTGRES_ADMIN_URL
  database:     $DB_NAME
  app db url:   $APP_DATABASE_URL
  base url:     $BASE_URL_VALUE
  log file:     $LOG_FILE
INFO

echo
if [ "$DROP_DB" = "1" ]; then
  echo "Creating temporary database..."
  if [[ ! "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]]; then
    echo "Refusing unsafe database name: $DB_NAME" >&2
    exit 1
  fi
  psql "$POSTGRES_ADMIN_URL" -v ON_ERROR_STOP=1 -c "create database \"$DB_NAME\";" >/dev/null
else
  echo "Using supplied WF_EXAMPLE_DATABASE_URL; database lifecycle is caller-owned."
fi

echo "Starting wf-example dev server..."
(
  cd "$ROOT_DIR"
  PORT="$PORT_VALUE" WF_EXAMPLE_DATABASE_URL="$APP_DATABASE_URL" pnpm --filter @fragno-example/wf-example dev --port "$PORT_VALUE" --strictPort
) >"$LOG_FILE" 2>&1 &
APP_PID=$!

echo "Waiting for $BASE_URL_VALUE ..."
deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
until curl -fsS "$BASE_URL_VALUE" >/tmp/wf-example-confirm-workflows.json 2>/dev/null; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "wf-example dev server exited before becoming ready" >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Timed out waiting for wf-example" >&2
    exit 1
  fi
  sleep 1
done

echo "wf-example is ready. Workflow list:"
cat /tmp/wf-example-confirm-workflows.json
echo

for script in "${SCRIPTS[@]}"; do
  echo
  echo "== Running $script =="
  BASE_URL="$BASE_URL_VALUE" \
  WF_EXAMPLE_DATABASE_URL="$APP_DATABASE_URL" \
  node "$ARTIFACT_DIR/$script"
done

echo
echo "Postgres.app confirmation passed. No trust-auth failures found in $LOG_FILE."
