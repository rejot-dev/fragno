#!/usr/bin/env bash
set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
source "$script_directory/common.sh"
demo_parse_arguments "${0##*/}" "$@"

demo_forward_request POST "/objects/$demo_name/alarm" '{"delayMs":0}'
demo_forward_request POST "/tick" '{}' internal
demo_forward_request GET "/objects/$demo_name" null
demo_forward_request GET "/control/$demo_name" null internal
