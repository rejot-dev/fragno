#!/bin/bash

# Script to run codex in a loop until an implementation plan is complete
# Usage: ./scripts/run-implementation-loop.sh <path-to-implementation-plan>
#
# Example:
#   ./scripts/run-implementation-loop.sh specs/workflows-fragment-implementation-plan.md

set -e

if [[ -z "$1" ]]; then
    echo "Error: No implementation plan specified"
    echo "Usage: $0 <path-to-implementation-plan>"
    exit 1
fi

IMPLEMENTATION_PLAN="$1"
PROMPT_TEMPLATE="prompt.md"
COMPLETION_MARKER="IMPLEMENTATION_COMPLETE_ALL_ITEMS_DONE"

if [[ ! -f "$IMPLEMENTATION_PLAN" ]]; then
    echo "Error: Implementation plan not found: $IMPLEMENTATION_PLAN"
    exit 1
fi

if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
    echo "Error: Prompt template not found: $PROMPT_TEMPLATE"
    exit 1
fi

echo "Starting implementation loop for: $IMPLEMENTATION_PLAN"
echo "=================================================="

iteration=0

while true; do
    iteration=$((iteration + 1))
    echo ""
    echo "=== Iteration $iteration ==="
    echo ""

    echo "--- Checking if implementation is complete ---"
    echo ""

    # Check if the implementation plan is complete
    check_result=$(codex exec --model gpt-5.1-codex-mini - <<EOF
Review the implementation plan at $IMPLEMENTATION_PLAN.

Tasks are marked complete with [x] (e.g., "- [x] Task done").
Tasks are incomplete if they have [ ] or no checkbox at all.

Check if there are ANY incomplete tasks ([ ] or missing checkbox on actionable items).
Ignore prose/description text - only check actual task items.

If ALL tasks have [x], output EXACTLY: $COMPLETION_MARKER
If there are incomplete tasks, output: INCOMPLETE - then list them.
EOF
)

    echo "$check_result"

    if echo "$check_result" | grep -q "$COMPLETION_MARKER"; then
        echo ""
        echo "=================================================="
        echo "🎉 Implementation complete! All items are done."
        echo "=================================================="
        exit 0
    fi

    echo ""
    echo "Implementation not yet complete, running implementation step..."
    echo ""

    # Substitute the placeholder in the prompt template
    prompt=$(sed "s|{{IMPLEMENTATION_PLAN}}|$IMPLEMENTATION_PLAN|g" "$PROMPT_TEMPLATE")

    # Run the main implementation step
    echo "$prompt" | codex exec --model gpt-5.2-codex --yolo -
done
