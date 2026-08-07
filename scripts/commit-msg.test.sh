#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMMIT_MSG_SCRIPT="$SCRIPT_DIR/commit-msg"
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

assert_accepts() {
  name=$1
  message_file="$TEMP_DIR/$name"
  cat > "$message_file"

  if ! "$COMMIT_MSG_SCRIPT" "$message_file" >/dev/null 2>&1; then
    echo >&2 "FAIL: expected '$name' to be accepted"
    exit 1
  fi
}

assert_rejects() {
  name=$1
  message_file="$TEMP_DIR/$name"
  cat > "$message_file"

  if "$COMMIT_MSG_SCRIPT" "$message_file" >/dev/null 2>&1; then
    echo >&2 "FAIL: expected '$name' to be rejected"
    exit 1
  fi
}

assert_accepts conventional <<'EOF'
feat(core): format commit messages

Keep commit messages readable and consistent.
EOF

assert_rejects merge <<'EOF'
Merge branch 'main' into feature
EOF

assert_rejects invalid <<'EOF'
Update commit message handling
EOF

long_subject_file="$TEMP_DIR/long-subject"
long_subject_output="$TEMP_DIR/long-subject-output"
long_subject='feat(core): this subject is intentionally longer than the configured seventy-two column limit'
printf '%s\n' "$long_subject" > "$long_subject_file"

if "$COMMIT_MSG_SCRIPT" "$long_subject_file" >"$long_subject_output" 2>&1; then
  echo >&2 "FAIL: expected a subject longer than 72 columns to be rejected"
  exit 1
fi

if ! grep -q '^ERROR: Commit subject exceeds 72 columns\.$' "$long_subject_output"; then
  echo >&2 "FAIL: long subject did not report the 72-column limit"
  exit 1
fi

if [ "$(cat "$long_subject_file")" != "$long_subject" ]; then
  echo >&2 "FAIL: long subject was modified instead of rejected"
  exit 1
fi

format_file="$TEMP_DIR/formatting"
cat > "$format_file" <<'EOF'
fix(core): wrap commit message bodies

This body line is intentionally long enough that the commit message hook must wrap it to the configured maximum of seventy-two columns.

- This list item is intentionally long enough that it must wrap with a hanging indentation while remaining easy to read.

Signed-off-by: Example Person <example@example.com>
EOF

"$COMMIT_MSG_SCRIPT" "$format_file" >/dev/null 2>&1

if awk 'length($0) > 72 { exit 1 }' "$format_file"; then
  :
else
  echo >&2 "FAIL: formatted message contains a line longer than 72 columns"
  exit 1
fi

if ! grep -q '^  hanging indentation while remaining easy to read\.$' "$format_file"; then
  echo >&2 "FAIL: list continuation does not use hanging indentation"
  exit 1
fi

if ! grep -q '^Signed-off-by: Example Person <example@example.com>$' "$format_file"; then
  echo >&2 "FAIL: commit trailer was modified"
  exit 1
fi

echo "PASS: commit message hook"
