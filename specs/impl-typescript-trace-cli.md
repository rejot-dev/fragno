# TypeScript Trace Analysis CLI — MVP Implementation Plan

## Goals

Build a small CLI package that turns raw TypeScript trace output into actionable reports for Fragno
contributors working on checker performance.

This MVP is specifically aimed at workflows like the recent `@fragno-dev/db` optimization work,
where we needed to answer questions such as:

- which project files are hottest in `types.json`
- which symbols in a file are responsible for most trace entries
- whether a refactor actually reduced counts for specific helper types
- whether cost moved from one hotspot to another
- how current results compare to a previous trace

## Scope

Create a new package, tentatively `packages/ts-trace-cli`, that can analyze TypeScript trace output
from a directory containing:

- `types.json`
- `trace.json`

MVP focus is on `types.json`, since that has been the most useful source for our current performance
investigations.

## MVP commands

- `ts-trace summary <traceDir>`
  - summarize top files and symbols
  - support project-local filtering by default or flag
- `ts-trace file <traceDir> <file>`
  - show top symbols declared in one file
  - group anonymous entries like `__type`, `__object`, `__function`
- `ts-trace symbol <traceDir> <symbol>`
  - show count, declaring files, and sample displays for a symbol
- `ts-trace compare <beforeTraceDir> <afterTraceDir>`
  - show file and symbol deltas
  - highlight biggest wins and regressions

## Expected usefulness

For Fragno contributors, this CLI should make it easy to:

- confirm that changes to files like `packages/fragno-db/src/schema/create.ts` actually help
- compare before/after traces for helper types like `RefreshTableTargets`, `TableBuilder`, or
  `MainSelectResult`
- filter out noise from TypeScript libs and `node_modules`
- generate reusable reports for specs, PRs, and follow-up optimization work

## Tasks

- [x] Scaffold `packages/ts-trace-cli` with package metadata, TypeScript config, build config, and a
      runnable CLI entrypoint.
- [x] Define a normalized internal model for `types.json` entries, including symbol name, display,
      flags, and repo-relative declaration path/position when available.
- [x] Define a normalized internal model for `trace.json` metadata/events sufficient for future
      extension, even if MVP commands do not deeply analyze timing yet.
- [x] Implement path normalization so absolute trace paths are converted to repo-relative paths when
      they belong to the current workspace.
- [x] Implement shared filtering utilities for: - project-only results - excluding `node_modules` -
      excluding TypeScript lib files - include/exclude path patterns
- [x] Implement `summary` command output for: - top files by trace-entry count - top symbols by
      count - top project-local files - top project-local symbols
- [x] Implement `file` command output for a repo-relative file path, including: - top symbols
      declared in that file - anonymous symbol group counts (`__type`, `__object`, `__function`) -
      optional raw sample lines/displays for inspection
- [x] Implement `symbol` command output for a symbol name, including: - total count - top
      declaration files - sample `display` strings when present
- [x] Implement `compare` command for two trace directories, including: - per-file deltas -
      per-symbol deltas - biggest improvements - biggest regressions
- [x] Add human-readable table output for terminal usage.
- [x] Add `--format json` output for all MVP commands so results can be reused in scripts, docs, or
      later CI automation.
- [x] Add fixture-based tests for parsing and normalization of both `types.json` and `trace.json`.
- [x] Add command-level tests for `summary`, `file`, `symbol`, and `compare`, using reduced trace
      fixtures derived from real TypeScript traces.
- [x] Add a README describing: - what TypeScript traces are - how to generate them - what each
      command is for - examples from Fragno-style workflows
- [x] Verify the CLI against a real trace directory such as `packages/fragno-db/trace-out` and
      confirm it can reproduce conclusions like: - `ColumnsToTuple` removed - `Table` count
      reduced - `TableBuilder` still hot - query-layer hotspots still dominate overall

## Suggested package structure

- `packages/ts-trace-cli/package.json`
- `packages/ts-trace-cli/src/cli.ts`
- `packages/ts-trace-cli/src/loaders/types-trace.ts`
- `packages/ts-trace-cli/src/loaders/event-trace.ts`
- `packages/ts-trace-cli/src/analysis/files.ts`
- `packages/ts-trace-cli/src/analysis/symbols.ts`
- `packages/ts-trace-cli/src/analysis/compare.ts`
- `packages/ts-trace-cli/src/formatters/table.ts`
- `packages/ts-trace-cli/src/formatters/json.ts`
- `packages/ts-trace-cli/src/util/paths.ts`
- `packages/ts-trace-cli/src/util/filters.ts`

## Design notes

- Favor repo-local views by default, since raw traces are dominated by TS libs and dependency
  declarations.
- Treat `types.json` entry counts as a useful proxy, not as exact checker-time measurements.
- Preserve raw `display` strings where available, since they are often the best explanation of why a
  type is expensive.
- Keep the output stable and scriptable so we can later add CI budgets or markdown/HTML reports
  without redesigning the data model.
- Do not overfit the package to `fragno-db`; it should work for any TypeScript package trace in the
  monorepo.

## Non-goals for MVP

These can come later if the MVP is successful:

- checker budget enforcement / CI failure thresholds
- HTML reports
- automatic trace generation wrappers
- heuristic “advice” engine for mapped types / distributivity / recursion
- deep `trace.json` timing attribution and flamegraph-style views

## Verification

Run at least the relevant package checks after implementation:

- `pnpm exec turbo build --filter=./packages/ts-trace-cli --output-logs=errors-only`
- `pnpm exec turbo types:check --filter=./packages/ts-trace-cli --output-logs=errors-only`
- `pnpm exec turbo test --filter=./packages/ts-trace-cli --output-logs=errors-only`

And manually validate against a real trace, e.g.:

- `packages/fragno-db/trace-out`

with commands like:

- `ts-trace summary packages/fragno-db/trace-out`
- `ts-trace file packages/fragno-db/trace-out packages/fragno-db/src/schema/create.ts`
- `ts-trace symbol packages/fragno-db/trace-out TableBuilder`
- `ts-trace compare <before> <after>`
