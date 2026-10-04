#!/usr/bin/env bash

demo_origin="${DEMO_FLEET_ORIGIN:-http://127.0.0.1:3210}"
demo_name="demo"
demo_node="node-1"

demo_parse_arguments() {
  local script_name="$1"
  shift
  while (( $# > 0 )); do
    case "$1" in
      --name)
        if (( $# < 2 )); then
          printf 'Missing value for --name\n' >&2
          exit 2
        fi
        demo_name="$2"
        shift 2
        ;;
      --name=*)
        demo_name="${1#*=}"
        shift
        ;;
      --node)
        if (( $# < 2 )); then
          printf 'Missing value for --node\n' >&2
          exit 2
        fi
        demo_node="$2"
        shift 2
        ;;
      --node=*)
        demo_node="${1#*=}"
        shift
        ;;
      --help|-h)
        printf 'Usage: %s [--name NAME] [--node NODE_SLOT]\n' "$script_name"
        exit 0
        ;;
      *)
        printf 'Unknown argument: %s\n' "$1" >&2
        exit 2
        ;;
    esac
  done

  if [[ ! "$demo_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ ]]; then
    printf 'Invalid object name: %s\n' "$demo_name" >&2
    exit 2
  fi
  if [[ ! "$demo_node" =~ ^node-[1-9][0-9]*$ ]]; then
    printf 'Invalid node slot: %s\n' "$demo_node" >&2
    exit 2
  fi
}

demo_print_json_response() {
  if command -v jq >/dev/null 2>&1; then
    jq .
  else
    cat
    printf '\n'
  fi
}

demo_get_fleet_json() {
  local pathname="$1"
  printf '\nGET %s%s\n' "$demo_origin" "$pathname"
  curl --fail-with-body --silent --show-error \
    "$demo_origin$pathname" | demo_print_json_response
}

demo_forward_request() {
  local method="$1"
  local pathname="$2"
  local body="$3"
  local ingress="${4:-application}"
  local payload
  payload="{\"ingress\":\"$ingress\",\"method\":\"$method\",\"path\":\"$pathname\",\"body\":$body}"
  printf '\n%s %s via %s\n' "$method" "$pathname" "$demo_node"
  curl --fail-with-body --silent --show-error \
    --request POST \
    --header 'content-type: application/json' \
    --data "$payload" \
    "$demo_origin/api/nodes/$demo_node/requests" |
    demo_print_json_response
}
