# @fragno-dev/mcp-fragment

## 0.1.0

### Minor Changes

- 4579483: feat: refresh MCP server configuration through durable hooks

### Patch Changes

- e2ed7ec: feat: support MCP 2026-07-28 with SDK v2, legacy fallback, complete tool listing, and
  issuer-validated OAuth. Tool results carry any JSON `structuredContent`, and the testing server
  requires a `protocolVersion`; custom OAuth callback forwarding must preserve `iss`.
- 741100b: feat: report sanitized auth status, resume pending OAuth links, reuse the OAuth client
  configured at creation, replace server configuration in place, discard tokens when reauthorizing,
  keep the auth mode when clearing auth, and return tool errors as results. Export an in-process
  test MCP server from `@fragno-dev/mcp-fragment/testing`.
- 3e7adf5: feat: cache MCP server metadata and discovered tools.
- 98af8f7: fix: forget a registered OAuth client and discovered metadata the server rejects, so the
  next consent registers a fresh client instead of reusing the rejected one
- ee5150d: feat: deliver the current server name and auth mode, or null after deletion, with
  `onServerReadinessChanged`.
- a352798: feat: accept explicit OAuth redirect URIs for authorization flows
- d1bb877: feat: replace tool list hook with MCP server refresh diagnostics.
- 5619ec0: Add the `onServerReadinessChanged` hook, which receives `{ serverId, ready }` when a
  write changes whether stored auth can authorize operations. Tokens the server rejects during an
  operation are now removed from storage, so status reports that consent is required instead of
  `authorized`.
- a1bfcc4: Report `ready: false` through `onConnectionReadinessChanged` and
  `onServerReadinessChanged` when an OAuth access token without a refresh token expires. A durable
  hook is scheduled at expiry and fires only if that token is still stored; a newer token reports
  its own readiness.
- 67e494a: feat: expose durable hook context objects to API and MCP callbacks.
- 8e2aea9: feat: expose durable hook propagation context to MCP callbacks.
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
  - @fragno-dev/node@0.0.9

## Unreleased

- Initial scaffold copy prepared for MCP fragment development.
