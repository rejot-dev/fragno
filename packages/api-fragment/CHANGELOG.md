# @fragno-dev/api-fragment

## 0.1.0

### Minor Changes

- dd23f45: Replace `onConnectionAvailable` with `onConnectionReadinessChanged`, which receives
  `{ connectionId, ready }` when a write changes whether stored auth can authorize requests: on
  creation, and when credentials, consent, or tokens flip readiness. Restarting consent while
  discarding tokens and clearing credentials now report the connection as not ready.

  This is a pre-1.0 breaking change: `onConnectionAvailable` and `ApiConnectionAvailablePayload` are
  removed.

- dff4e1f: `onWebhookEndpointChanged` now also fires with `{ change: "deleted", endpointId }` when
  an endpoint is deleted, and updates carry `previousStatus` so consumers can tell when an endpoint
  starts or stops accepting deliveries. The payload is a discriminated union on `change`; handlers
  that read `endpoint` must narrow it first. This is a pre-1.0 breaking change.

  Webhook endpoints now report `deliveries`: the last accepted request and the last rejected one
  with its error code. Configuration writes clear both. The schema adds three nullable columns to
  `webhookEndpoint`, so run the Fragment's migrations.

### Patch Changes

- bd4b1e9: feat: validate connection slugs, paginate connections, report sanitized auth status,
  resume pending OAuth links, replace a connection's configuration in place, and restart OAuth
  consent while discarding stored tokens. Clearing auth now keeps the connection's auth mode.
- 411b929: refactor: replace the package root barrel with direct server and client imports.
- ee5150d: feat: deliver the current connection, or null after deletion, with
  `onConnectionReadinessChanged`.
- 7f1d3d9: feat: store accepted webhook deliveries, readable through
  `GET /webhooks/endpoints/:endpointId/deliveries/:deliveryId`, and delete them
  `webhookDeliveryRetentionMs` after their `onWebhookReceived` hook succeeds. Breaking: set the new
  required `webhookDeliveryRetentionMs` option, and type `onWebhookReceived` payloads as
  `WebhookDelivery` from `@fragno-dev/api-fragment/types`, which replaces `WebhookReceivedPayload`.
  `onWebhookReceived` hooks queued before upgrading complete without running.
- 09d8508: feat: add outbound API integration fragment.
- c8388d1: feat: accept explicit OAuth redirect URIs for authorization flows
- daf01dc: feat: add Basic authentication and typed outbound API request results.
- 16838f2: fix: include status text in outbound API request responses.
- a1bfcc4: Report `ready: false` through `onConnectionReadinessChanged` and
  `onServerReadinessChanged` when an OAuth access token without a refresh token expires. A durable
  hook is scheduled at expiry and fires only if that token is still stored; a newer token reports
  its own readiness.
- 67e494a: feat: expose durable hook context objects to API and MCP callbacks.
- 46bb57b: feat: expose durable hook propagation context to API callbacks.
- 6d50c7e: feat emit durable hooks when webhook endpoints are created or updated
- 5e0cfe8: feat: add API fragment webhook receiver endpoints.
- 63f76fc: feat: add authenticated webhook challenges and prefixed timestamped HMAC payloads.
- Updated dependencies [0d4cbe8]
- Updated dependencies [2797663]
- Updated dependencies [fcecfed]
- Updated dependencies [d2da73f]
- Updated dependencies [cff3b99]
- Updated dependencies [fcd0179]
- Updated dependencies [4db850e]
- Updated dependencies [766f977]
- Updated dependencies [27b7db5]
- Updated dependencies [9419f78]
- Updated dependencies [73e14d7]
- Updated dependencies [a8010b8]
- Updated dependencies [26a21e3]
- Updated dependencies [eb6ea3e]
- Updated dependencies [71b0233]
- Updated dependencies [0186a7a]
- Updated dependencies [4fd5010]
- Updated dependencies [2ab64f4]
- Updated dependencies [3f9d1bb]
- Updated dependencies [867bc9d]
- Updated dependencies [8b651fe]
- Updated dependencies [b79e697]
- Updated dependencies [c1314be]
- Updated dependencies [767c934]
- Updated dependencies [b854e42]
- Updated dependencies [c13b6c7]
- Updated dependencies [e6d80bb]
- Updated dependencies [d9a5ffe]
- Updated dependencies [a15bcc2]
- Updated dependencies [719ac3b]
- Updated dependencies [d1b4bd9]
- Updated dependencies [83bea0b]
- Updated dependencies [9a01df4]
- Updated dependencies [d92f4ce]
- Updated dependencies [1d2125e]
- Updated dependencies [fc794d7]
- Updated dependencies [0cf8414]
- Updated dependencies [fe0e92d]
- Updated dependencies [20324e7]
- Updated dependencies [6b028b6]
- Updated dependencies [c1255e4]
- Updated dependencies [318921d]
- Updated dependencies [92adef0]
- Updated dependencies [7e2d989]
- Updated dependencies [d62cc57]
- Updated dependencies [ae415ff]
- Updated dependencies [204bbb7]
- Updated dependencies [8a60280]
- Updated dependencies [2b8f4b7]
- Updated dependencies [a7bf719]
- Updated dependencies [9ea7170]
- Updated dependencies [187d67e]
- Updated dependencies [aff91d1]
- Updated dependencies [03d5a5c]
- Updated dependencies [a28094e]
- Updated dependencies [b4fc242]
- Updated dependencies [033a643]
- Updated dependencies [c41c1e2]
- Updated dependencies [bfe589e]
- Updated dependencies [6cc8f36]
- Updated dependencies [f42c8c6]
- Updated dependencies [9cd79f3]
- Updated dependencies [7a625f6]
- Updated dependencies [d689267]
- Updated dependencies [49ca4fb]
- Updated dependencies [0e63275]
- Updated dependencies [4944ecf]
- Updated dependencies [d9ac2a3]
- Updated dependencies [4e5d611]
- Updated dependencies [2dbc550]
- Updated dependencies [2dbc550]
- Updated dependencies [7405040]
- Updated dependencies [04fac88]
- Updated dependencies [b40a129]
- Updated dependencies [5256cee]
- Updated dependencies [6c0de3b]
- Updated dependencies [f297b5d]
- Updated dependencies [caf581b]
- Updated dependencies [02e29d4]
- Updated dependencies [7de0078]
- Updated dependencies [ff3673f]
- Updated dependencies [d7236a2]
- Updated dependencies [1e1088b]
- Updated dependencies [9e2ee05]
- Updated dependencies [3734573]
- Updated dependencies [1c57f29]
- Updated dependencies [2e7263b]
- Updated dependencies [801e6ab]
- Updated dependencies [f510d32]
- Updated dependencies [48c0094]
- Updated dependencies [7a60491]
- Updated dependencies [6649e1f]
- Updated dependencies [3570c2a]
- Updated dependencies [d125074]
- Updated dependencies [8afaf3d]
- Updated dependencies [2d729a4]
- Updated dependencies [85be413]
- Updated dependencies [fa21507]
- Updated dependencies [79055dd]
- Updated dependencies [e7b36e1]
- Updated dependencies [a61b3a5]
- Updated dependencies [4dc14bf]
- Updated dependencies [3328fe3]
- Updated dependencies [a64dc64]
- Updated dependencies [ea8ea88]
- Updated dependencies [5599183]
- Updated dependencies [e2cad8d]
- Updated dependencies [93bc657]
- Updated dependencies [5e0cfe8]
- Updated dependencies [9919fdd]
  - @fragno-dev/db@0.5.0
  - @fragno-dev/core@0.2.3

## 0.0.1

- Initial skeleton copy prepared for webhook fragment development.
