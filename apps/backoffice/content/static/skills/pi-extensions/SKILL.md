---
name: pi-extensions
description: >
  Create, build, activate, and verify codemode-backed Pi workspace extensions with prompt sections,
  tools, and built-in task hooks. Load when extending Pi behavior, editing its extensions manifest,
  rebuilding an extension, or diagnosing extension loading or callback failures.
---

# Pi workspace extensions

Use **author → build → activate → verify**. Author native `@earendil-works/pi-durable` definitions;
Backoffice installs host proxies and runs their callbacks in sealed codemode Workers. This is a
supported subset of the durable extension API, not a host-loaded coding-agent plugin. Building
creates generic code; Pi validates registrations when a scoped session opens.

## 1. Preflight

Read `/static/skills/javascript-runtime/SKILL.md` for build/runtime semantics and permissions, and
`/static/codemode/providers/state.d.ts` for workspace operations. Confirm `js.build` is declared and
available before authoring a module that needs it. For session verification, read
`/static/codemode/providers/pi.d.ts` and apply the system's closed-world preflight.

Work in the intended user, organization, or project scope. Extensions are loaded only from that
scope's workspace; system scope does not load workspace extensions. Inspect any existing
`/workspace/pi/extensions.json` and relevant source before editing. Preserve unrelated extensions.

**Complete when** scope, build availability, workspace access, and the existing activation entries
are known. Report missing capabilities as blockers instead of attempting implicit compilation.

## 2. Author a supported native module

Save a `.js` source file, for example `/workspace/pi/extensions/project-context.js`, using
`state.writeFile({ path, content })`. This example reads optional workspace guidance at render time:

```js
import { defineExtension, section } from "@earendil-works/pi-durable";

export default defineExtension({
  name: "project-context",
  sections: [
    section("project_context", async ({ env }) => {
      const path = "/workspace/AGENTS.md";
      const exists = await env.exists(path);
      if (!exists.ok) throw new Error(exists.error.message);
      if (!exists.value) return undefined;

      const file = await env.readTextFile(path);
      if (!file.ok) throw new Error(file.error.message);
      return file.value;
    }),
  ],
});
```

### Supported registrations and capabilities

The default export accepts `name`, `sections`, `tools`, and `hooks`. Supply at least one section,
tool, or hook registration; each collection is limited to 16 entries. Tools-only and hooks-only
extensions are valid.

| Registration                                                                                  | Supported behavior                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `section(key, render, { tag })`                                                               | String/undefined rendering; input has `conversationId`, `shown`, and read-only `env`. Tagging defaults to true.                                                                        |
| `defineTool({ name, description, parameters, execute, replay, executionMode, outputLimits })` | Native argument validation, execution, output, diagnostics, details, usage, and post-tool controls. Parameters are serializable JSON Schema; symbols from TypeBox are not transported. |
| `hook(GenerationTask, handlers)`                                                              | `beforeRequest`, `afterResponse`, `onYield`, `afterTools`.                                                                                                                             |
| `hook(ToolTask, handlers)`                                                                    | `beforeTool`, `afterTool`; block/rewrite calls or replace results.                                                                                                                     |
| `hook(CompactionTask, handlers)`                                                              | `beforeCompact`; decline or provide a summary.                                                                                                                                         |

Choose distinct names and section keys across activated extensions and built-ins. Extension names
match `^[a-zA-Z][a-zA-Z0-9_.-]*$`, tool names match `^[a-zA-Z][a-zA-Z0-9_-]*$`, and section keys
match `^[a-z][a-z0-9_-]*$` (lowercase, underscores/hyphens, no dots). Names/keys are at most 128
characters. `backoffice`, `instructions`, and installed tool names such as `read`, `search`, and
`execCodeMode` cannot be overridden. Native registry validation rejects duplicate registrations
within an extension.

**Sections and hook callbacks** have read-only workspace access. The environment exposes `id`,
`cwd: "/workspace"`, `readTextFile(path)`, and `exists(path)`. Sections receive it as `input.env`;
hooks receive the Backoffice addition `api.env`. Paths stay under `/workspace/` or `/static/`. File
methods return `{ ok: true, value }` or `{ ok: false, error }`; check the result. A rendered section
is limited to 65,536 UTF-8 bytes.

**Tool callbacks** receive `api.taskId`, `conversationId`, `callId`, the same read-only `env`, and:

- `api.output(stringOrUint8Array)` and `api.diagnostic({ severity, message, code })`: synchronous
  reporting, forwarded in order and joined before the guest finishes; at most 512 reports per call.
  Each output chunk is limited to 65,536 UTF-8 bytes; bound content before reporting it.
- `await api.details(jsonValue, context)`: publish running details.
- `api.providers`: Backoffice's addition for approved runtime-tool calls in the current scope, for
  example `await api.providers.state.readFile({ path })`. Read the relevant provider declaration and
  perform the closed-world preflight before authoring a call. Provider availability and live
  permissions still apply. Writes or external operations go through these authorized providers;
  read-only `api.env` does not provide them.

**Tools and hooks** receive `api.memo(name, context)` and `api.memo(name, candidate, context)`.
Memos are durable first-writer-wins JSON values scoped to the calling task, not a conversation-wide
store. A tool and its before/after hooks share that task's memos. Use a unique memo name; writing
again returns the existing winner. Hook arguments and return decisions follow their native
signatures. Return `undefined` to leave behavior unchanged; return valid JSON data for a decision or
tool result.

### Example: tool and tool hook

```js
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";

export default defineExtension({
  name: "project-tools",
  tools: [
    defineTool({
      name: "project_guidance",
      description: "Read the project's workspace guidance.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      replay: "safe",
      execute: async (_args, api, context) => {
        const file = await api.env.readTextFile("/workspace/AGENTS.md");
        if (!file.ok) throw new Error(file.error.message);
        api.output(file.value);
        await api.details({ path: "/workspace/AGENTS.md" }, context);
        return {};
      },
    }),
  ],
  hooks: [
    hook(ToolTask, {
      beforeTool: (call) =>
        call.name === "execCodeMode" ? { block: "This session is read-only." } : undefined,
    }),
  ],
});
```

A hook blocks only the named native call; that example is not a general read-only security policy.
Provider permissions remain the authorization boundary.

### Not supported

- Custom `tasks`, custom-task hooks, `wraps`, `prepareArguments`, or `constrainedSampling`. These
  registrations are rejected during inspection, even when an unsupported collection is empty.
- Durable document APIs: `commit`, `snapshot`, `snapshotAsOf`, `watchDoc`; task creation/waits;
  conversation/subagent handles; registry access; full resolved-agent access (`api.agent`,
  `prompt.agent`, or `prompt.read`). Unsupported API calls fail explicitly.
- Direct `fetch`, host bindings, host credentials, filesystem/shell APIs from a full native
  `ExecutionEnv`, or runtime-provider globals such as `state`. Use `api.env` or `api.providers`; a
  separate imported module cannot see the invocation wrapper's local provider variables.
- Host Chord context values or a cooperative guest abort signal. The trailing callback context
  carries no host values; cancellation is enforced by terminating the activation and revoking host
  capabilities, not by delivering the host's signal to guest code.
- Persistent module globals, background listeners, retained callbacks, or hot reload. Inspection,
  rendering, tool execution, and each hook run in fresh module state with a 10-second deadline. Keep
  initialization pure: inspection has no providers. Perform I/O inside callbacks.

Tools default to `replay: "unsafe"`: interrupted calls are not silently repeated. Declare `safe`
only when the complete tool behavior is safe to repeat. Native hook retry/recovery semantics still
apply; use task memos where appropriate. A successful provider mutation is not rolled back when a
callback later fails or is cancelled.

Use the installed SDK import as shown. Standalone `js.check` and source `js.run` reject this import;
compile through `js.build` rather than removing the native authoring API to satisfy those commands.

**Complete when** every registration and callback uses only supported capabilities, replay policy
matches its side effects, and I/O is inside callbacks rather than module initialization.

## 3. Build before activating

```bash
js.build /workspace/pi/extensions/project-context.js \
  --out /workspace/pi/.build/project-context.module.json
```

Apply the JavaScript runtime skill's build checks: observe success, review warnings, and retain the
returned artifact path. The saved artifact is generic `fragno-javascript-module/v1` code; Pi
metadata is validated later. A successful build proves compilation only. Failed builds leave the old
artifact intact, so activation must not be described as updated after a failed rebuild.

**Complete when** the intended source has successfully produced the intended artifact. Leave the
manifest unchanged on build failure.

## 4. Activate explicitly and preserve existing entries

The manifest is `/workspace/pi/extensions.json` with exactly this shape:

```json
{
  "extensions": ["./.build/project-context.module.json"]
}
```

Entries identify built `.json` artifacts under the current `/workspace/`. Relative entries resolve
against `/workspace/pi`, not the source directory or shell working directory. Absolute workspace
paths are also accepted; using them makes read-modify-write activation straightforward:

```js
async () => {
  const path = "/workspace/pi/extensions.json";
  const artifactPath = "/workspace/pi/.build/project-context.module.json";
  const manifest = (await state.exists({ path }))
    ? await state.readJson({ path })
    : { extensions: [] };

  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).some((key) => key !== "extensions") ||
    !Array.isArray(manifest.extensions) ||
    manifest.extensions.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("Existing Pi extensions manifest is invalid; inspect it before changing it.");
  }
  const activatedPaths = await Promise.all(
    manifest.extensions.map((entry) => state.resolvePath({ base: "/workspace/pi", path: entry })),
  );
  if (new Set(activatedPaths).size !== activatedPaths.length) {
    throw new Error(
      "Existing manifest activates one artifact more than once; inspect its entries.",
    );
  }
  if (!activatedPaths.includes(artifactPath)) manifest.extensions.push(artifactPath);
  if (manifest.extensions.length > 16)
    throw new Error("Pi supports at most 16 activated extensions.");

  await state.writeJson({ path, value: manifest });
  return await state.readJson({ path });
};
```

Compare resolved paths, as above: different spellings of one file are duplicate activation, not
separate extensions. Preserve existing valid entries. Source `.js` entries, traversal through `..`,
and paths outside the workspace are invalid activation references.

**Complete when** the re-read manifest contains the successfully built artifact exactly once and all
unrelated entries remain intact. Building or placing a file in a conventional directory does not
activate it.

## 5. Verify in a newly opened session

Create a fresh scoped session with `pi.createSession`, using a new verification request ID; reuse
that ID only when retrying the same creation. Existing open sessions retain their captured bundle
and metadata, so rebuilding or editing a manifest is not a hot reload.

Verify the contributed behavior: inspect rendered sections when available, otherwise use a narrow
smoke prompt; invoke a custom tool and inspect its actual result; exercise a hook's intended
decision and inspect the affected call/result. Inspect extension load/callback reports. Session
creation, a successful generic `js.run`, or a model's unsupported claim alone is not proof of
installation.

**Complete only when** the new session demonstrably exercises the intended contribution. If
verification is unavailable, report the source/artifact/manifest paths as built and listed, with
activation verification explicitly outstanding.

### Diagnose the failing stage

- **Build required or invalid artifact:** check the manifest's resolved path, rebuild the source,
  and open a fresh session. Source references and old Pi-specific artifact formats need rebuilding;
  session opening never compiles source or falls back to it.
- **Invalid export or unsupported member:** use a default extension with the supported registrations
  above. Compilation accepts ordinary modules that Pi may reject.
- **Duplicate name, tool, section, or path:** compare the manifest and all activated extensions,
  including reserved built-ins and path aliases; rename the conflict or remove only the duplicate
  entry.
- **Startup or global-scope failure:** move I/O into render callbacks and keep initialization pure.
- **Read/provider denied:** use an allowed path and verify live scope permissions/provider
  availability.
- **Invalid callback result/report:** return the native data shape; sections return
  string/undefined, tools return a result object, and hooks return their decision or undefined.
  Bound text and reports.
- **Unsupported API:** choose an authorized runtime provider instead of a document/transaction,
  subagent, full-environment, or wrapper API.

Load, section, and hook failures are reported without taking down the session; tool failures become
native error results. Built-in guidance can still work. A usable session therefore does not
establish extension success. Rebuild after source edits; workspace file content changes are read
freshly by subsequent renders of the captured callback.
