---
name: javascript-runtime
description: >
  Use js.check, js.build, and js.run to check saved JavaScript, compile reusable built modules,
  execute source or bundles, diagnose build or startup errors, and review runs' outcomes, logs, and
  tool calls with js.runs.list and js.runs.get. Load when a task uses the js.* runtime.
---

# JavaScript runtime

Use **check → build when needed → run → inspect** for saved JavaScript. Use immediate codemode for
one-off provider work; saved files are useful when the user needs repeatable scripts or a module
consumed by another runtime.

## 1. Preflight

Read `/static/codemode/providers/js.d.ts` and `/static/codemode/providers/state.d.ts`. Apply the
system's closed-world preflight to every provider the script calls. Treat live declarations and
runtime availability as authoritative: if the required method or compiler is unavailable, report
that blocker rather than guessing a replacement API.

Choose the operation:

| Operation                 | Input                                     | Purpose                                                                                 |
| ------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `js.check({ path })`      | `.js` source                              | Type-check it and its imports against the static declarations; does not execute.        |
| `js.build({ path, out })` | `.js` source and workspace `.json` output | Compile an ES module into a reusable built module; does not execute or inspect exports. |
| `js.run({ path })`        | `.js` source or a built `.json` module    | Execute top-level statements; ignore named and default exports.                         |

For durable steps, retries, sleeps, or external events, read `/static/skills/workflows/SKILL.md` and
use the workflow runtime. Saved `.workflow.js` files start through `workflow.createInstance`, not
`js.run`.

**Complete when** the operation, available methods, concrete scope, and required permissions are
known. Workspace files belong to the current scope; another organization's or project's files are
not implicitly visible.

## 2. Save and check source

Write UTF-8 JavaScript with `state.writeFile({ path, content })`. Source paths are `.js` files under
`/workspace/` or `/static/`; author editable files under `/workspace/`. Codemode paths must be
absolute. Bash resolves relative paths against its current working directory.

A runnable source file contains top-level work, for example:

```js
const total = [2, 3, 5].reduce((sum, value) => sum + value, 0);
console.log("Total:", total);
```

A run finishes as soon as its top-level statements settle; the runtime does not wait for timers or
other pending work. Callbacks from `setTimeout` or `setInterval` and unawaited promises are dropped
with their logs and effects. Await all work at the top level, and start the file with `export {};`
so it is a module: `js.check` accepts top-level `await` only in modules.

```js
export {};

await new Promise((resolve) => setTimeout(resolve, 5_000));
console.log("Five seconds have passed");
```

An exported function is a definition, not an entrypoint: `export default async () => { ... }` does
not execute its body under `js.run`. The run output contains logs, not the module's exports or a
returned export value.

Source imports other saved `.js` modules under `/workspace/` or `/static/` by absolute path or
relative to the importing file, as with `import { echo } from "../integrations/tools.js"`; typed
integration clients from `integrations.generateClient` are such modules. Imports name the file with
its `.js` extension. Each run and check reads the imported modules as they are saved.

Every saved file is such a module, including a `.workflow.js` file, whose default export is its
workflow: `export default defineWorkflow(...)`. Workflows start through `workflow.createInstance` or
a route, not `js.run`; `js.check` checks a workflow file's default export too. Inline `execCodeMode`
code is one expression instead of a module, so it loads saved modules with
`await import("/workspace/...")` by absolute path.

Check source before execution:

```js
async () => {
  const checked = await js.check({ path: "/workspace/scripts/example.js" });
  return checked;
};
```

Inspect `valid` and every diagnostic's path, line, column, code, and message. Diagnostics cover the
imported modules too, and an import that cannot be loaded is a diagnostic at the import. Fix them
and check again. Source checking, builds, and execution resolve saved modules, not npm packages.
Build success is not a substitute for type-check success.

**Complete when** the source has `valid: true`.

## 3. Build a reusable module when needed

Use a build when a built module must run without a compiler or another consumer needs module
exports:

```bash
js.build /workspace/scripts/example.js --out /workspace/.build/example.module.json
```

```js
async () => {
  const built = await js.build({
    path: "/workspace/scripts/example.js",
    out: "/workspace/.build/example.module.json",
  });
  if (built.status !== "success") throw new Error(built.error);
  return built;
};
```

- Output is a `.json` file under the current `/workspace/`. `.build/` and `.module.json` are naming
  conventions, not required locations or suffixes. Use direct paths without `..` traversal.
- Builds bundle the source with the saved modules it imports. The built module captures imported
  modules as they were at build time: rebuild after editing one.
- The generic `fragno-javascript-module/v1` module contains code, not capability grants or a
  consumer-specific invocation wrapper. Use `js.build` without a target option.
- Building does not initialize the module. A successful build can still fail at startup or fail a
  consumer's export validation.
- Review `warnings`. Failed compilation preserves the previous output: an older built module still
  existing is not evidence that the latest source built successfully.

Checking and running require `upload.read`; building also requires `upload.modify` and an available
compiler. **Complete when** the build returns `status: "success"` with the intended `outputPath`, or
its exact error is reported. Preserve the returned path for execution.

## 4. Run and inspect

```bash
js.run /workspace/scripts/example.js
js.run /workspace/.build/example.module.json --format json
```

```js
async () => {
  const executed = await js.run({ path: "/workspace/.build/example.module.json" });
  return executed;
};
```

Inspect `status`:

| `status`   | Meaning                                                                    | Fields                   |
| ---------- | -------------------------------------------------------------------------- | ------------------------ |
| `success`  | The run finished                                                           | `runId`, `logs`          |
| `error`    | The run failed to compile, threw, or was interrupted                       | `runId`, `logs`, `error` |
| `rejected` | No run result: the file was refused or execution could not start or report | `error`                  |

`js.build` returns the same three statuses; its `runId` names the build run. Bash prints logs and
returns a nonzero exit code for anything but `success`; `--format json` preserves the structured
result, including `runId`. Tool permission and configuration failures may throw instead.

In structured results, each `logs` entry is `{ at, channel, text }`. `channel` is the console method
(`log`, `info`, `debug`, `warn`, `error`), or `codemode` for runtime notes such as compiler warnings
and log truncation. `at` is epoch milliseconds from the run's clock, which only advances across
awaited I/O: rely on array order, not timestamps, to sequence lines. Bash text output prints `text`,
prefixed with `[channel]` for every channel except `log`.

Built module execution validates the bundle, imports its `mainModule` and bundled dependencies in a
fresh isolated Worker, and ignores exports. It uses captured code, so source deletion or editing
does not change an existing built module. Rebuild after source edits. Each run starts with fresh
module state and fresh authorized capabilities; built modules need no compiler or dependency
installation. Node execution additionally checks the Cap'n Web serialized payload against its RPC
frame budget, including escaped source and metadata. `CODEMODE_REMOTE_PAYLOAD_LIMIT_EXCEEDED` means
the module must be reduced or executed with a native Worker Loader; an oversized remote build fails
before publishing a new built module.

Native module initialization can fail on asynchronous I/O, including top-level network or tool
calls. Let the error surface; keep initialization pure and use immediate codemode or a consumer's
callback for request-time I/O. There is no rewrite or source-compilation fallback after a built
module failure. Malformed or incompatible built modules should be rebuilt with the available
runtime, not hand-edited to bypass validation. A transport interruption leaves effects already
performed with an unknown outcome; inspect state and the run history below before repeating
effectful work.

### Run history

Every build and run, like immediate codemode, is recorded as a run in the current scope. Use the run
ID that `js.run` or `js.build` returned, or find one with `js.runs.list`:

```bash
js.runs.list           # newest first: run ID, start time, status, activation, origin
js.runs.get <run-id>   # one run: its outcome, error, console logs, and tool calls
```

| Field                | Contents                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `status`             | `running`, `completed`, `failed`, or `suspended` (a workflow tick waiting)                  |
| `activation`         | `module-build` (`js.build`), `module` (`js.run` source), `compiled` (`js.run` built module) |
| `origin`             | `{ kind: "file", path }` for saved files; `{ kind: "inline" }` for immediate code           |
| `logs`               | Console output, stored when the run finishes                                                |
| `toolCalls`          | Calls in order, recorded as they happen, each with `input` and, once settled, `output`      |
| `toolCallsTruncated` | `true` when the run made more than 200 calls; only the first 200 are listed                 |

Call `input` and `output` are JSON cut to 500 characters; a failed call's output is its error, and
tools that return credentials store `"[redacted]"`. A run still `running` after its caller stopped
waiting never reported finishing: treat its effects as unknown. Its `toolCalls` show which tools it
reached; a call still `running` may have taken effect.

Reading a run requires at least the authority it had: the same principal, a delegation chain the
run's chain extends (a delegate cannot read its principal's direct runs, while the principal can
read its delegates' runs), and a scope restriction that contains the run's. Otherwise `js.runs.get`
fails with `CODEMODE_RUN_FORBIDDEN`, and `js.runs.list` leaves the run out of its page. Runs are
kept for 7 days; an older run ID fails with `CODEMODE_RUN_NOT_FOUND`.

A failed run other than a workflow tick also emits a `codemode` `run.failed` event, with the error
and `subject.runId`, for automations to react to.

**Complete only when** the observed run succeeds and its expected logs or authorized effects are
verified, or the observed failure and blocking requirement are reported.
