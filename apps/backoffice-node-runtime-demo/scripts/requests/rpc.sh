#!/usr/bin/env bash
set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
source "$script_directory/common.sh"
demo_parse_arguments "${0##*/}" "$@"

demo_forward_request POST "/objects/$demo_name/callback" '{}'
demo_forward_request POST "/objects/$demo_name/capability" '{"deltas":[4,1]}'
demo_forward_request POST "/objects/$demo_name/values" '{}'
demo_forward_request POST "/objects/$demo_name/fetch/increment" '{"delta":2,"label":"shell-request-response-rpc"}'
demo_forward_request GET "/objects/$demo_name/fetch/stream" null
