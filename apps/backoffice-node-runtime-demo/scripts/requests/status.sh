#!/usr/bin/env bash
set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
source "$script_directory/common.sh"
demo_parse_arguments "${0##*/}" "$@"

printf 'Fleet overview: %s/\n' "$demo_origin"
demo_get_fleet_json "/health"
demo_get_fleet_json "/api/fleet"
demo_forward_request GET "/control/demo" null internal
demo_forward_request GET "/control/secondary" null internal
if [[ "$demo_name" != "demo" && "$demo_name" != "secondary" ]]; then
  demo_forward_request GET "/control/$demo_name" null internal
fi
