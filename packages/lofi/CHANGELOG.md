# @fragno-dev/lofi

## 0.0.2

### Patch Changes

- 5b05bd1: feat: add lofi submit client and local handler tx helpers
- cbe9667: feat: add outbox decoding and mutation transform utilities
- 65fdf11: fix: require client schema module for the lofi CLI
- 257f14e: feat: add lofi cli serve/client/scenario commands and scenario DSL export
- 2c650fc: fix(lofi): avoid double-applying confirmed optimistic updates
- 9812530: feat(lofi): add in-memory lofi adapter for optimistic overlay
- 7fe3470: fix: dedupe outbox entries by uow+versionstamp
- 3aac02e: feat(lofi): add IndexedDB adapter for local-first client
- f43536c: feat(lofi): add IndexedDB base snapshot export for overlays
- bcf8a45: feat: add overlay manager to rebuild optimistic state from base + queue
- 7a2c69d: feat(lofi): add initial lofi package scaffold
- 2488521: feat: add IndexedDB query engine with local filtering, joins, and cursors
- e69b2f8: fix(lofi): remove IndexedDbAdapter base snapshot export APIs
- 24526b9: feat: add stacked adapter that merges base and optimistic overlay reads
- ed22f3f: fix: route optimistic execution through stacked adapter
- 26d8174: feat(lofi): add onSyncApplied hook for LofiClient
- c03602c: feat: support stacked adapter scenarios with indexeddb injection
- Updated dependencies [3e2ff94]
- Updated dependencies [c8841b5]
- Updated dependencies [ae54a60]
- Updated dependencies [7dd7055]
- Updated dependencies [3ffa711]
- Updated dependencies [95cdf95]
- Updated dependencies [eabdb9c]
- Updated dependencies [9eeba53]
- Updated dependencies [49a9f4f]
- Updated dependencies [dcba383]
- Updated dependencies [c895c07]
- Updated dependencies [ed4b4a0]
- Updated dependencies [ad2ef56]
- Updated dependencies [0f9b7ef]
- Updated dependencies [fe55a13]
- Updated dependencies [91a2ac0]
- Updated dependencies [7bda0b2]
  - @fragno-dev/db@0.3.1
  - @fragno-dev/core@0.2.1
  - @fragno-dev/node@0.0.8
