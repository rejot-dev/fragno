---
name: javascript-runtime
description: >
  Use js.check, js.build, and js.run to check saved JavaScript, compile reusable module artifacts,
  execute source or bundles, and diagnose build or startup errors. Load when a task uses the js.*
  runtime; Pi workspace extension authoring also uses the pi-extensions skill.
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

| Operation                 | Input                                               | Purpose                                                                             |
| ------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `js.check({ path })`      | Standalone `.js` source                             | Type-check against the static declarations; does not execute.                       |
| `js.build({ path, out })` | `.js` source and workspace `.json` output           | Compile an ES module into a reusable artifact; does not execute or inspect exports. |
| `js.run({ path })`        | Standalone `.js` source or a built `.json` artifact | Execute top-level statements; ignore named and default exports.                     |

For durable steps, retries, sleeps, or external events, read `/static/skills/workflows/SKILL.md` and
use the workflow runtime. Saved `.workflow.js` files start through `workflow.createInstance`, not
`js.run`. Pi section modules follow the Pi Extensions skill's consumer contract and activation
process; this skill owns their build/runtime semantics.

**Complete when** the operation, available methods, concrete scope, and required permissions are
known. Workspace files belong to the current scope; another organization's or project's files are
not implicitly visible.

## 2. Save and check standalone source

Write UTF-8 JavaScript with `state.writeFile({ path, content })`. Source paths are `.js` files under
`/workspace/` or `/static/`; author editable files under `/workspace/`. Codemode paths must be
absolute. Bash resolves relative paths against its current working directory.

A runnable source file contains top-level work, for example:

```js
const total = [2, 3, 5].reduce((sum, value) => sum + value, 0);
console.log("Total:", total);
```

An exported function is a definition, not an entrypoint: `export default async () => { ... }` does
not execute its body under `js.run`. The run output contains logs, not the module's exports or a
returned export value.

Check standalone source before execution:

```js
async () => {
  const checked = await js.check({ path: "/workspace/scripts/example.js" });
  return checked;
};
```

Inspect `valid` and every diagnostic's path, line, column, code, and message. Fix source diagnostics
and check again. Standalone checking and source execution reject module imports and re-exports from
other modules; SDK-importing modules use the build branch below instead. Build success is not a
substitute for type-check success.

**Complete when** standalone source has `valid: true`, or the task deliberately uses the compiled
module branch because it needs supported imports.

## 3. Build a reusable module when needed

Use a build when an artifact must run without a compiler or another consumer needs module exports:

```bash
js.build /workspace/scripts/example.js --out /workspace/.build/example.module.json
```

```js
async () => {
  const built = await js.build({
    path: "/workspace/scripts/example.js",
    out: "/workspace/.build/example.module.json",
  });
  if (built.status === "error") throw new Error(built.error);
  return built;
};
```

- Output is a `.json` file under the current `/workspace/`. `.build/` and `.module.json` are naming
  conventions, not required locations or suffixes. Use direct paths without `..` traversal.
- Builds accept one source file and the installed, pinned `@earendil-works/pi-durable` dependency;
  additional workspace modules and arbitrary npm dependencies are outside this build contract.
- The generic `fragno-javascript-module/v1` artifact contains code, not Pi metadata, capability
  grants, or a consumer-specific invocation wrapper. Use `js.build` without a target option.
- Build neither initializes the module nor activates an extension. A successful build can still fail
  at startup or fail a consumer's export validation.
- Review `warnings`. Failed compilation preserves the previous output: an older artifact still
  existing is not evidence that the latest source built successfully.

Checking and running require `upload.read`; building also requires `upload.modify` and an available
compiler. **Complete when** the build returns `status: "success"` with the intended `artifactPath`,
or its exact error is reported. Preserve the returned path for execution or consumer activation.

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

Inspect `status` and `logs`; on `status: "error"`, also inspect `error`. Bash prints logs and
returns a nonzero exit code for a run error; `--format json` preserves the structured result. Tool
permission, configuration, and transport failures may throw instead of returning a run result.

Artifact execution validates the bundle, imports its `mainModule` and bundled dependencies in a
fresh isolated Worker, and ignores exports. It uses captured code, so source deletion or editing
does not change an existing artifact. Rebuild after source edits. Each run starts with fresh module
state and fresh authorized capabilities; artifacts need no compiler or dependency installation. Node
execution additionally checks the Cap'n Web serialized payload against its RPC frame budget,
including escaped source and metadata. `CODEMODE_REMOTE_PAYLOAD_LIMIT_EXCEEDED` means the module
must be reduced or executed with a native Worker Loader; an oversized remote build fails before
publishing a new artifact.

Native module initialization can fail on asynchronous I/O, including top-level network or tool
calls. Let the error surface; keep initialization pure and use immediate codemode or a consumer's
callback for request-time I/O. There is no rewrite or source-compilation fallback after an artifact
failure. Malformed or incompatible artifacts should be rebuilt with the available runtime, not
hand-edited to bypass validation. A transport interruption leaves effects already performed with an
unknown outcome; inspect state before repeating effectful work.

**Complete only when** the observed run succeeds and its expected logs or authorized effects are
verified, or the observed failure and blocking requirement are reported. Running a Pi artifact
initializes it but does not invoke sections or prove Pi activation.
