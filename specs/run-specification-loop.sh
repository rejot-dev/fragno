#!/bin/bash

# Script to run codex in a loop until an implementation plan is complete
# Usage: ./specs/run-implementation-loop.sh [--plan <path-to-implementation-plan>] [--prompt <path-to-prompt>] [--issue <issue-id>]
#
# Example:
#   ./specs/run-implementation-loop.sh --plan specs/impl-ai-fragment.md
#   ./specs/run-implementation-loop.sh --plan specs/impl-ai-fragment.md --prompt specs/PROMPT.md
#   ./specs/run-implementation-loop.sh --prompt specs/PROMPT.md --issue FP-123

set -e

IMPLEMENTATION_PLAN=""
PROMPT_TEMPLATE="prompt.md"
ISSUE=""
COMPLETION_MARKER="<promise>TASKS_FINISHED</promise>"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --plan)
            if [[ -z "$2" ]]; then
                echo "Error: --plan requires a file path"
                echo "Usage: $0 [--plan <path-to-implementation-plan>] [--prompt <path-to-prompt>] [--issue <issue-id>]"
                exit 1
            fi
            IMPLEMENTATION_PLAN="$2"
            shift 2
            ;;
        --prompt)
            if [[ -z "$2" ]]; then
                echo "Error: --prompt requires a file path"
                echo "Usage: $0 [--plan <path-to-implementation-plan>] [--prompt <path-to-prompt>] [--issue <issue-id>]"
                exit 1
            fi
            PROMPT_TEMPLATE="$2"
            shift 2
            ;;
        --issue)
            if [[ -z "$2" ]]; then
                echo "Error: --issue requires an issue id"
                echo "Usage: $0 [--plan <path-to-implementation-plan>] [--prompt <path-to-prompt>] [--issue <issue-id>]"
                exit 1
            fi
            ISSUE="$2"
            shift 2
            ;;
        *)
            echo "Error: Unknown argument: $1"
            echo "Usage: $0 [--plan <path-to-implementation-plan>] [--prompt <path-to-prompt>] [--issue <issue-id>]"
            exit 1
            ;;
    esac
done

if [[ -n "$IMPLEMENTATION_PLAN" && ! -f "$IMPLEMENTATION_PLAN" ]]; then
    echo "Error: Implementation plan not found: $IMPLEMENTATION_PLAN"
    exit 1
fi

if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
    echo "Error: Prompt template not found: $PROMPT_TEMPLATE"
    exit 1
fi

if [[ -n "$IMPLEMENTATION_PLAN" ]]; then
    echo "Starting implementation loop for: $IMPLEMENTATION_PLAN"
else
    echo "Starting implementation loop"
fi
echo "=================================================="

iteration=0

while true; do
    iteration=$((iteration + 1))
    echo ""
    echo "=== Iteration $iteration ==="
    echo ""

    echo "Implementation step..."
    echo ""

    # Substitute placeholders in the prompt template
    if [[ -n "$ISSUE" ]]; then
        prompt=$(sed \
            -e "s|{{IMPLEMENTATION_PLAN}}|$IMPLEMENTATION_PLAN|g" \
            -e "s|{{ISSUE}}|$ISSUE|g" \
            "$PROMPT_TEMPLATE")
    else
        prompt=$(sed \
            -e "s|{{IMPLEMENTATION_PLAN}}|$IMPLEMENTATION_PLAN|g" \
            -e "/{{ISSUE}}/d" \
            "$PROMPT_TEMPLATE")
    fi

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
