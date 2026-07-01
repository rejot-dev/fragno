# @fragno-dev/pi-fragment

## 1.0.0

### Major Changes

- 81542e7: refactor: remove pi tool replay and side-effect reducer APIs

### Patch Changes

- f984a61: feat: add command-based sessions with restored turns and Pi JSONL export.
- 06428f8: fix: update Mario Zechner pi dependencies and preserve replay behavior.
- 916eb6d: feat: support dynamically resolved Pi skill registries
- 0e9acb4: fix: reconnect Pi session event streams after clean EOF.
- fb2d7f7: feat: add custom Pi workflow sessions, typed workflow DSL helpers, and replayable agent steps.
- 662e7d6: fix: await async workflow previousEmissions
- 50e0cff: feat: export Pi route schemas from a public subpath.
- 60dc522: feat: add Pi lifecycle event routes and live session clients.
- a64773f: fix: persist Pi skill resolution failures on agent steps
- b182389: refactor: migrate Pi tests to shared workflow scenario harness
- 073f89b: feat: scope Pi session routes and clients by workflow name.
- 4b21047: feat: support resolving Pi system prompts before appending skill catalogs
- b48b27d: feat: add skill-aware agent steps to the Pi workflow DSL.
- fa21507: fix: restore interrupted Pi agent turns from live step emissions and publish commit markers.
- 6c10a63: fix: filter stale live step emissions after a competing epoch commits.
- f856070: Ensure all non-private packages include repository metadata in their `package.json` entries.
- b41824f: feat: add waitForEvent onConsume hooks for event consumption side effects
- Updated dependencies [0d4cbe8]
- Updated dependencies [fcecfed]
- Updated dependencies [27b7db5]
- Updated dependencies [9419f78]
- Updated dependencies [0186a7a]
- Updated dependencies [17e5ab9]
- Updated dependencies [3f9d1bb]
- Updated dependencies [20324e7]
- Updated dependencies [8a60280]
- Updated dependencies [bceb49b]
- Updated dependencies [aff91d1]
- Updated dependencies [03d5a5c]
- Updated dependencies [a28094e]
- Updated dependencies [5f98d46]
- Updated dependencies [6cc8f36]
- Updated dependencies [d961df2]
- Updated dependencies [f42c8c6]
- Updated dependencies [0e63275]
- Updated dependencies [26f85f9]
- Updated dependencies [4944ecf]
- Updated dependencies [4e5d611]
- Updated dependencies [f297b5d]
- Updated dependencies [ff3673f]
- Updated dependencies [fda1ff9]
- Updated dependencies [1e1088b]
- Updated dependencies [9e2ee05]
- Updated dependencies [3734573]
- Updated dependencies [662e7d6]
- Updated dependencies [fa21507]
- Updated dependencies [42353ac]
- Updated dependencies [79055dd]
- Updated dependencies [e7b36e1]
- Updated dependencies [3328fe3]
- Updated dependencies [6c10a63]
- Updated dependencies [a64dc64]
- Updated dependencies [f856070]
- Updated dependencies [ea8ea88]
- Updated dependencies [b41824f]
- Updated dependencies [5e0cfe8]
- Updated dependencies [9919fdd]
- Updated dependencies [6edb80b]
- Updated dependencies [397aba2]
- Updated dependencies [073f89b]
- Updated dependencies [102238e]
- Updated dependencies [68c03ce]
- Updated dependencies [3712e27]
- Updated dependencies [28974f4]
- Updated dependencies [e8845d1]
  - @fragno-dev/db@0.4.2
  - @fragno-dev/core@0.2.3
  - @fragno-dev/workflows@1.0.0

## 0.0.3

### Patch Changes

- 0020e39: fix: align nanostores dependencies on version 1.2 across Fragno packages
- Updated dependencies [0020e39]
  - @fragno-dev/core@0.2.2
  - @fragno-dev/workflows@0.0.3
  - @fragno-dev/db@0.4.1

## 0.0.2

### Patch Changes

- 5a38ba3: feat: add pi fragment package and cli
- 211d6cd: feat: add live workflow state snapshots for Pi session detail routes
- 1ca66ec: feat: restore current-run pi session detail state
- f78acfc: feat: add live session client stores and active session streaming
- 41a1a5f: feat: add tool-call replay middleware with persisted journals
- 0a43498: fix: align pi session workflow state and live session UI
- Updated dependencies [8a96998]
- Updated dependencies [3e2ff94]
- Updated dependencies [f34d7d7]
- Updated dependencies [4d141f8]
- Updated dependencies [c8841b5]
- Updated dependencies [83f6223]
- Updated dependencies [ff7f461]
- Updated dependencies [ae54a60]
- Updated dependencies [7dd7055]
- Updated dependencies [e178bf4]
- Updated dependencies [99827a4]
- Updated dependencies [d2f68ba]
- Updated dependencies [567c3b3]
- Updated dependencies [75191db]
- Updated dependencies [d395ad2]
- Updated dependencies [75407f3]
- Updated dependencies [8a2da9d]
- Updated dependencies [bfdd4b1]
- Updated dependencies [3ffa711]
- Updated dependencies [c2c3229]
- Updated dependencies [e559425]
- Updated dependencies [fc5c256]
- Updated dependencies [93fa469]
- Updated dependencies [2d2e728]
- Updated dependencies [14e00b1]
- Updated dependencies [f33286c]
- Updated dependencies [b3ad7eb]
- Updated dependencies [211d6cd]
- Updated dependencies [95cdf95]
- Updated dependencies [eabdb9c]
- Updated dependencies [9eeba53]
- Updated dependencies [49a9f4f]
- Updated dependencies [dcba383]
- Updated dependencies [c895c07]
- Updated dependencies [ed4b4a0]
- Updated dependencies [1102ce0]
- Updated dependencies [2ae432c]
- Updated dependencies [ad2ef56]
- Updated dependencies [9f87189]
- Updated dependencies [0f9b7ef]
- Updated dependencies [6d043ea]
- Updated dependencies [fe55a13]
- Updated dependencies [3832fa1]
- Updated dependencies [01fc2cb]
- Updated dependencies [f4aedad]
- Updated dependencies [f042c9d]
- Updated dependencies [0176aa8]
- Updated dependencies [00f2631]
- Updated dependencies [c13c1c1]
- Updated dependencies [0a6c8da]
- Updated dependencies [7a40517]
- Updated dependencies [91a2ac0]
- Updated dependencies [91a2ac0]
- Updated dependencies [7bda0b2]
- Updated dependencies [c115600]
- Updated dependencies [94a593f]
- Updated dependencies [b84a3d0]
- Updated dependencies [bb1b92b]
- Updated dependencies [0cc2c9e]
- Updated dependencies [387431b]
  - @fragno-dev/db@0.4.0
  - @fragno-dev/core@0.2.1
  - @fragno-dev/workflows@0.0.2
