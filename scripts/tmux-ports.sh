#!/usr/bin/env bash

set -euo pipefail

function print_usage() {
  cat <<'EOF'
Usage: tmux-ports.sh

Lists every tmux pane with the TCP ports its processes listen on, so you can find the pane that
runs a server. A pane owns a port when the listening process descends from the pane's shell.
EOF
}

if [[ $# -gt 0 ]]; then
  print_usage
  exit 1
fi

function list_listening_sockets() {
  local lsof_errors
  local lsof_output
  local lsof_status=0

  lsof_errors=$(mktemp)
  # -w drops warnings, so anything on stderr is an error.
  lsof_output=$(lsof -w -nP -iTCP -sTCP:LISTEN -F pn 2>"$lsof_errors") || lsof_status=$?

  # lsof exits 1 without output when no socket matches; it also exits 1 on errors, but reports them.
  if [[ "$lsof_status" -eq 1 && ! -s "$lsof_errors" ]]; then
    lsof_status=0
  fi
  if [[ "$lsof_status" -ne 0 ]]; then
    printf 'tmux-ports.sh: lsof failed with status %s\n' "$lsof_status" >&2
    cat "$lsof_errors" >&2
    rm -f "$lsof_errors"
    exit 1
  fi
  rm -f "$lsof_errors"

  # "<pid> <address:port>" for every listening TCP socket.
  awk '/^p/ { pid = substr($0, 2) } /^n/ { print pid, substr($0, 2) }' <<<"$lsof_output"
}

listeners=$(list_listening_sockets)
process_tree=$(ps -A -o pid=,ppid=)

function get_descendant_pids() {
  local pids="$1"
  local frontier="$1"

  while [[ -n "$frontier" ]]; do
    frontier=$(awk -v parents=" $frontier " 'index(parents, " " $2 " ") { print $1 }' \
      <<<"$process_tree" | tr '\n' ' ')
    pids="$pids $frontier"
  done
  printf '%s\n' "$pids"
}

tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_pid}' |
  while read -r pane pane_pid; do
    pids=" $(get_descendant_pids "$pane_pid") "
    ports=$(awk -v pids="$pids" 'NF && index(pids, " " $1 " ") { print $2 }' <<<"$listeners" |
      sort -u | tr '\n' ' ')
    printf '%-24s %s\n' "$pane" "${ports:--}"
  done
