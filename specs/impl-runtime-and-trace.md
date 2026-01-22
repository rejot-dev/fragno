# Fragno Runtime + Traceable Model Checker — Implementation Plan

Tasks are scoped to:

- `specs/spec-workflows-fragment.md` (Sections 6.7, 7.4, 12, 14.3)
- `specs/spec-in-memory-adapter.md` (Sections 9.1–9.3)

- [x] Add `FragnoRuntime` types in `@fragno-dev/core` with default `time` and `random` providers
      (`float`/`uuid`/`cuid`); export from the package and update any `tsdown.config.ts`/package
      exports as required.
- [x] Replace all sources of nondeterminism in the workflows fragment and related packages with
      `FragnoRuntime` (including `Math.random`, `crypto.randomUUID`, and `new Date()`), updating any
      necessary adapters for legacy callers.
- [x] Update workflows fragment config to require `runtime` and remove `clock`; thread runtime into
      `definition.ts`, `runner.ts`, and any helper utilities for `now()`, instance IDs, and runner
      IDs.
- [x] Update workflows test harness to accept a runtime, wire deterministic clock/random, and update
      existing tests/examples to pass the new runtime interface.
- [x] Replace direct uses of `Math.random`, `crypto.randomUUID`, and `new Date()` in workflows with
      `runtime.random` / `runtime.time` (SPEC §6.7), adding any necessary adapters for legacy
      callers.
- [x] Extend model checker APIs to accept an optional `runtime` and a `traceRecorder`/`traceHasher`
      surface; implement trace event collection for retrieval outputs, mutation inputs/outputs, and
      runtime events (SPEC §9.2–9.3).
- [x] Add a core internal trace sink for route/middleware decisions (auth allow/deny, route inputs)
      so external trace events are captured without exposing fragment-level APIs.
- [x] Implement normalized trace serialization and optional trace-based path hashing, with the
      ability to combine trace hashes with state hashes.
- [x] Add tests covering trace event capture, trace hashing determinism, and runtime trace capture
      in model checker runs.
- [x] Update workflows fragment docs (and any model-checker docs) to describe runtime injection and
      trace-based coverage guidance.
