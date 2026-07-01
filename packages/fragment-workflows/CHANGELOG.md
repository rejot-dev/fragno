# @fragno-dev/workflows

## 1.0.0

### Major Changes

- 662e7d6: feat: add remote workflow step hosts and make previousEmissions async

### Patch Changes

- 17e5ab9: feat: expose current step emission streams for workflow instances
- bceb49b: fix: cap retry execution at max attempts and stabilize status pagination
- 5f98d46: feat: make workflow event sends idempotent with optional event ids.
- d961df2: feat add reactive Lofi runtimes and query stores, and export the workflow schema entrypoint.
- 26f85f9: feat: support named remote workflow instances
- ff3673f: feat: expose id-based workflow status, history, events, and reusable param validation.
- fda1ff9: fix: enqueue workflow ticks for all non-terminal events and add runner-scoped scenario APIs.
- 3734573: fix: treat same-process buffered pump scope collisions as workflow runner contention
- fa21507: fix: restore interrupted Pi agent turns from live step emissions and publish commit markers.
- 42353ac: feat: add workflowServiceCalls for creating workflow instances from step transactions
- 6c10a63: fix: filter stale live step emissions after a competing epoch commits.
- f856070: Ensure all non-private packages include repository metadata in their `package.json` entries.
- b41824f: feat: add waitForEvent onConsume hooks for event consumption side effects
- 6edb80b: fix: make public workflow instance creation idempotent by instance id.
- 397aba2: fix: allow workflow instances to be created without a read phase.
- 073f89b: feat: scope workflow instance ids by workflow name.
- 102238e: fix: return nextCursor for instance pagination and reject terminal management actions.
- 68c03ce: feat: add a workflow instance retry management API.
- 3712e27: feat: persist and stream workflow step emissions.
- 28974f4: feat: add workflow step live state support and richer workflow test helpers
- e8845d1: feat: emit hooks when workflow instances reach terminal states.
- Updated dependencies [0d4cbe8]
- Updated dependencies [fcecfed]
- Updated dependencies [27b7db5]
- Updated dependencies [9419f78]
- Updated dependencies [0186a7a]
- Updated dependencies [3f9d1bb]
- Updated dependencies [20324e7]
- Updated dependencies [8a60280]
- Updated dependencies [aff91d1]
- Updated dependencies [03d5a5c]
- Updated dependencies [a28094e]
- Updated dependencies [6cc8f36]
- Updated dependencies [f42c8c6]
- Updated dependencies [0e63275]
- Updated dependencies [4944ecf]
- Updated dependencies [4e5d611]
- Updated dependencies [f297b5d]
- Updated dependencies [ff3673f]
- Updated dependencies [1e1088b]
- Updated dependencies [9e2ee05]
- Updated dependencies [3734573]
- Updated dependencies [fa21507]
- Updated dependencies [79055dd]
- Updated dependencies [e7b36e1]
- Updated dependencies [3328fe3]
- Updated dependencies [a64dc64]
- Updated dependencies [ea8ea88]
- Updated dependencies [5e0cfe8]
- Updated dependencies [9919fdd]
  - @fragno-dev/db@0.4.2
  - @fragno-dev/core@0.2.3

## 0.0.3

### Patch Changes

- Updated dependencies [0020e39]
  - @fragno-dev/core@0.2.2
  - @fragno-dev/db@0.4.1

## 0.0.2

### Patch Changes

- 4d141f8: fix: remove development exports from published packages
- ff7f461: refactor: streamline runner hooks and remove workflow bindings
- 99827a4: feat: type workflow state restore by workflow name
- 2d2e728: feat: add workflow scenario DSL
- 211d6cd: feat: add live workflow state snapshots for Pi session detail routes
- 3832fa1: feat: remove legacy pause fields and waitingForPause status
- f042c9d: feat: add typed workflow state restore support
- 91a2ac0: fix: execute step-scoped mutations inside step boundary commits
- 91a2ac0: feat: add WorkflowStepTx API for step-scoped mutations
- 94a593f: feat: add WorkflowStepTx.onTerminalError.mutate for terminal step failures
- bb1b92b: fix: move workflows client export to a dedicated subpath
- 0cc2c9e: fix: use db time for workflow runner scheduling
- 387431b: fix: require workflows test harness to receive a test builder
- Updated dependencies [8a96998]
- Updated dependencies [3e2ff94]
- Updated dependencies [f34d7d7]
- Updated dependencies [4d141f8]
- Updated dependencies [c8841b5]
- Updated dependencies [83f6223]
- Updated dependencies [ae54a60]
- Updated dependencies [7dd7055]
- Updated dependencies [e178bf4]
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
- Updated dependencies [14e00b1]
- Updated dependencies [f33286c]
- Updated dependencies [b3ad7eb]
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
- Updated dependencies [01fc2cb]
- Updated dependencies [f4aedad]
- Updated dependencies [f042c9d]
- Updated dependencies [0176aa8]
- Updated dependencies [00f2631]
- Updated dependencies [c13c1c1]
- Updated dependencies [0a6c8da]
- Updated dependencies [7a40517]
- Updated dependencies [91a2ac0]
- Updated dependencies [7bda0b2]
- Updated dependencies [c115600]
- Updated dependencies [b84a3d0]
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
