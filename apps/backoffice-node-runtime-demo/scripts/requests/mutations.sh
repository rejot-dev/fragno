#!/usr/bin/env bash
set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
source "$script_directory/common.sh"
demo_parse_arguments "${0##*/}" "$@"

multi_object_body='{"increments":[{"name":"demo","delta":1},{"name":"secondary","delta":7}]}'
if [[ "$demo_name" != "demo" && "$demo_name" != "secondary" ]]; then
  multi_object_body="{\"increments\":[{\"name\":\"demo\",\"delta\":1},{\"name\":\"secondary\",\"delta\":7},{\"name\":\"$demo_name\",\"delta\":11}]}"
fi

demo_forward_request POST "/objects/$demo_name/increments" '{"deltas":[2,3],"label":"shell-output-gate"}'
demo_forward_request POST "/multi-object-increments" "$multi_object_body"
demo_forward_request POST "/objects/$demo_name/compatibility-value" '{"value":"durable KV from mutations.sh"}'
demo_forward_request POST "/objects/$demo_name/background" '{"note":"waitUntil completed from mutations.sh"}'
demo_forward_request GET "/objects/demo" null
demo_forward_request GET "/objects/secondary" null
if [[ "$demo_name" != "demo" && "$demo_name" != "secondary" ]]; then
  demo_forward_request GET "/objects/$demo_name" null
fi
