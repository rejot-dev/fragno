#!/bin/bash

# Script to run codex in a loop until an implementation plan is complete
# Usage: ./scripts/run-implementation-loop.sh <path-to-implementation-plan>
#
# Example:
#   ./scripts/run-implementation-loop.sh specs/impl-ai-fragment.md

set -e

if [[ -z "$1" ]]; then
    echo "Error: No implementation plan specified"
    echo "Usage: $0 <path-to-implementation-plan>"
    exit 1
fi

IMPLEMENTATION_PLAN="$1"
PROMPT_TEMPLATE="prompt.md"
COMPLETION_MARKER="<promise>TASKS_FINISHED</promise>"

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

    echo "Implementation step..."
    echo ""

    # Substitute the placeholder in the prompt template
    prompt=$(sed "s|{{IMPLEMENTATION_PLAN}}|$IMPLEMENTATION_PLAN|g" "$PROMPT_TEMPLATE")

    # Run the main implementation step
    output=$(echo "$prompt" | codex exec --model gpt-5.2-codex --config model_reasoning_effort="medium" --yolo -)
    echo "$output"

    if echo "$output" | grep -q "$COMPLETION_MARKER"; then
        echo ""
        echo "=================================================="
        echo "🎉 Implementation complete! All items are done."
        echo "=================================================="
        exit 0
    fi
done
