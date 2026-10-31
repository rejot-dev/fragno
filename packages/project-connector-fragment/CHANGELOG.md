# @fragno-dev/project-connector-fragment

## 0.1.0

### Minor Changes

- f9656e5: Make `connectionName` non-null on stored connection requests and connected accounts, and
  in the request and account response contracts. Every start has required a name, so no stored row
  is expected to be null.

  This is a pre-1.0 breaking change: schema version 6 fails to migrate a database that holds a
  request or account without a connection name.

### Patch Changes

- 9d3c14a: fix: execute Connector actions with nested ids such as `googledrive.files.list`
- 34dea7d: fix: confirm a connection request the gateway no longer knows as expired instead of
  failing with HTTP 502, so a new OAuth attempt can replace it
- 208ada8: feat: expose allowlisted action contracts using separate catalog credentials.
- 00dfaee: fix: validate connection names and log Project Connector gateway failures
- 48b97c8: feat: add OAuth provider configuration and action discovery.
- 4c27980: feat: add verified provider connections, profiles, actions, and a CLI.
- d7dfce5: Report `ready: false` through `onConnectionReadinessChanged` for a connection name that
  loses its only account when reauthorization moves that account ID to another name.
- 0d88a42: feat: add resumable named OAuth lookups and client hooks with safe account ownership and
  redirects.
- f9656e5: feat: add the `onConnectionReadinessChanged` durable hook, which receives
  `{ externalUserId, service, connection, ready }` when a named connection gains its first request
  (`ready: false`) or its first confirmed account (`ready: true`).
- 0d0e834: feat: `POST /connection-requests` accepts `replace: true` to start over under a name,
  deleting its earlier requests; once the new request confirms, its account replaces the name's
  others.
- fa724d8: feat: `GET /connection-requests/current` (`useCurrentConnectionRequests`) lists a user's
  requests across names, 25 per page; schema version 7 adds the index it pages by.
- 5c96e4a: fix: reject catalog redirects before forwarding credentials.
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

## Unreleased

- Added project-scoped OAuth connections with verified, user-owned account bindings.
- Added account profiles, cursor-based account listing, and explicit action execution.
- Added `fragno-project-connector` CLI commands for project-key checks, Gmail authorization,
  profiles, and actions, with environment-file loading, SQLite persistence, and optional
  authorization beeps.
