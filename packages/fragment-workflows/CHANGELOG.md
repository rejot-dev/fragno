# @fragno-dev/workflows

## 1.0.0

### Major Changes

- 3832fa1: feat: remove legacy pause fields and waitingForPause status

### Patch Changes

- 4d141f8: fix: remove development exports from published packages
- ff7f461: refactor: streamline runner hooks and remove workflow bindings
- 2d2e728: feat: add workflow scenario DSL
- 91a2ac0: fix: execute step-scoped mutations inside step boundary commits
- 91a2ac0: feat: add WorkflowStepTx API for step-scoped mutations
- bb1b92b: fix: move workflows client export to a dedicated subpath
- 0cc2c9e: fix: use db time for workflow runner scheduling
- 387431b: fix: require workflows test harness to receive a test builder
- Updated dependencies [8a96998]
- Updated dependencies [3e2ff94]
- Updated dependencies [f34d7d7]
- Updated dependencies [4d141f8]
- Updated dependencies [c8841b5]
- Updated dependencies [ae54a60]
- Updated dependencies [7dd7055]
- Updated dependencies [e178bf4]
- Updated dependencies [d2f68ba]
- Updated dependencies [d395ad2]
- Updated dependencies [bfdd4b1]
- Updated dependencies [3ffa711]
- Updated dependencies [e559425]
- Updated dependencies [14e00b1]
- Updated dependencies [95cdf95]
- Updated dependencies [eabdb9c]
- Updated dependencies [9eeba53]
- Updated dependencies [49a9f4f]
- Updated dependencies [dcba383]
- Updated dependencies [c895c07]
- Updated dependencies [ed4b4a0]
- Updated dependencies [2ae432c]
- Updated dependencies [ad2ef56]
- Updated dependencies [0f9b7ef]
- Updated dependencies [6d043ea]
- Updated dependencies [fe55a13]
- Updated dependencies [01fc2cb]
- Updated dependencies [f4aedad]
- Updated dependencies [00f2631]
- Updated dependencies [0a6c8da]
- Updated dependencies [7a40517]
- Updated dependencies [91a2ac0]
- Updated dependencies [7bda0b2]
- Updated dependencies [c115600]
  - @fragno-dev/db@0.4.0
  - @fragno-dev/core@0.2.1

## 0.0.1

### Patch Changes

- 656be22: feat(workflows): add client hooks, helpers, and browser builds for workflow fragments.
- 7e1eb47: feat(db): add processAt scheduling and reusable durable hooks dispatchers.
- e450c6e: feat(workflows): simplify workflow routes and include instance createdAt in instance
  listings.
- 3041732: fix: run durable hooks off-request and relax pending task leases
- afb06a4: feat(core,wf): add FragnoRuntime defaults and require runtime in workflows config.
- 37810d6: fix(workflows): return updated task fields when claiming workflow tasks.
- c770b69: perf(fragment-workflows): reduce runner roundtrips and require OCC checks
- Updated dependencies [f569301]
- Updated dependencies [dbbbf60]
- Updated dependencies [3e07799]
- Updated dependencies [20a98f8]
- Updated dependencies [1902f30]
- Updated dependencies [15e3263]
- Updated dependencies [208cb8e]
- Updated dependencies [33f671b]
- Updated dependencies [fc803fc]
- Updated dependencies [0628c1f]
- Updated dependencies [7e1eb47]
- Updated dependencies [301e2f8]
- Updated dependencies [5f6f90e]
- Updated dependencies [1dc4e7f]
- Updated dependencies [2eafef4]
- Updated dependencies [3c9fbac]
- Updated dependencies [a5ead11]
- Updated dependencies [7d7b2b9]
- Updated dependencies [c4d4cc6]
- Updated dependencies [d4baad3]
- Updated dependencies [548bf37]
- Updated dependencies [a79e90d]
- Updated dependencies [3041732]
- Updated dependencies [7e179d1]
- Updated dependencies [0013fa6]
- Updated dependencies [7c60341]
- Updated dependencies [afb06a4]
- Updated dependencies [53e5f97]
- Updated dependencies [8e9b6cd]
- Updated dependencies [c5fd7b3]
- Updated dependencies [69b9a79]
- Updated dependencies [5cef16e]
  - @fragno-dev/core@0.2.0
  - @fragno-dev/db@0.3.0
