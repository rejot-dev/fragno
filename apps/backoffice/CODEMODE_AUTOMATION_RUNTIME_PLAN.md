# Codemode automation and AI session runtime plan

## Intent

Add a second automation runtime for backoffice automations and Pi/agent sessions based on
`@cloudflare/codemode` and `@cloudflare/shell`.

The target state is:

- Pi agents have a `runStateCode` tool that runs JavaScript in a Cloudflare dynamic worker.
- Automations can run either bash scripts or codemode scripts.
- Both runtimes use the same backoffice domain tool definitions.
- Tool definitions are redesigned with fully breaking changes where useful.
- The new tool definition model directly accommodates both bash and codemode instead of treating one
  runtime as an adapter bolted onto the other.

## Current state

Relevant files:

- `app/fragno/automation/definition.ts`
  - Loads automation bindings and currently dispatches every binding to `executeBashAutomation`.
- `app/fragno/bash-runtime/bash-host.ts`
  - Creates the `just-bash` host, mounts `/context/event.json`, and registers command families.
- `app/fragno/bash-runtime/*-bash-runtime.ts`
  - Current command families for `automations`, `event`, `otp`, `pi`, `resend`, `reson8`, and
    `telegram`.
- `app/fragno/pi/pi.ts`
  - Creates the Pi `bash` tool for agent sessions.
- `app/fragno/pi/pi-shared.ts`
  - Currently has `PI_TOOL_IDS = ["bash"]`.
- `workers/automations.do.ts`
  - Durable Object entrypoint for the automations runtime.
- `workers/pi.do.ts`
  - Durable Object entrypoint for Pi sessions.
- `/Users/wilco/dev/agents/examples/workspace-chat/src/server.ts`
  - Reference implementation for `runStateCode` using `DynamicWorkerExecutor` and `stateTools`.

## Guiding decisions

### Fully breaking changes are allowed

We should not preserve the current command/type structure if it makes the new model awkward. In
particular, the current `*-bash-runtime.ts` files are allowed to be split, renamed, or replaced.

### Tool definitions must be runtime-aware

Do **not** design a codemode-only object tool model and then backfill bash as a thin afterthought.
Do **not** preserve the current bash command specs as the source of truth.

Instead, define a first-class backoffice tool model that has explicit runtime implementations for:

- codemode/object invocation,
- bash/CLI invocation.

A tool may support one runtime or both.

### Codemode should be the preferred automation runtime

Bash can remain available, but the new model should make object-shaped codemode tools the primary
interface for agents and new automations.

### Network access remains explicit

Dynamic worker code should run with `globalOutbound: null` by default. External effects should go
through explicit tools such as `telegram`, `resend`, `pi`, `reson8`, `otp`, `automations`, and
`event`.

## Proposed new structure

Add a new runtime/tool area:

```txt
apps/backoffice/app/fragno/runtime-tools/
  definition.ts
  context.ts
  registry.ts
  codemode-provider.ts
  bash-commands.ts
  families/
    automations.ts
    event.ts
    otp.ts
    pi.ts
    resend.ts
    reson8.ts
    telegram.ts
```

Add codemode execution helpers:

```txt
apps/backoffice/app/fragno/codemode/
  execute.ts
  master-file-system-state.ts
  result.ts
```

Extract shared automation execution filesystem helpers:

```txt
apps/backoffice/app/fragno/automation/engine/execution-file-system.ts
apps/backoffice/app/fragno/automation/engine/bash.ts
apps/backoffice/app/fragno/automation/engine/codemode.ts
```

Worker-only helpers may live under:

```txt
apps/backoffice/workers/lib/codemode-runtime.ts
```

## Runtime tool definition model

The new tool definition should encode both runtime surfaces directly.

Sketch:

```ts
export type BackofficeRuntimeKind = "codemode" | "bash";

export type BackofficeToolContext = {
  orgId?: string;
  env?: CloudflareEnv;
  automation?: {
    event: AutomationEvent;
    binding: AutomationTriggerBinding;
    idempotencyKey: string;
  };
  runtimes: {
    automations?: AutomationsRuntimeApi;
    event?: EventRuntimeApi;
    otp?: OtpRuntimeApi;
    pi?: PiRuntimeApi;
    resend?: ResendRuntimeApi;
    reson8?: Reson8RuntimeApi;
    telegram?: TelegramRuntimeApi;
  };
};

export type BackofficeRuntimeTool<TInput, TOutput> = {
  id: string;
  namespace: string;
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;

  execute: (input: TInput, context: BackofficeToolContext) => Promise<TOutput>;

  codemode?: {
    name?: string;
    description?: string;
  };

  bash?: {
    command: string;
    help: AutomationCommandHelp;
    parse: (args: string[]) => TInput;
    format?: (output: TOutput, options: AutomationCommandOutputOptions) => BashCommandResult;
  };
};
```

Important details:

- `execute(...)` is the semantic operation.
- `codemode` declares the object-call surface.
- `bash` declares the CLI-call surface.
- Both runtimes are represented in the definition itself.
- Names can intentionally differ:
  - codemode: `telegram.sendMessage({ chatId, text })`
  - bash: `telegram.chat.send --chat-id ... --text ...`
- The old `ParsedCommandByName`, `AutomationCommandSpec`, and per-file command maps can be replaced.

## Runtime providers

### Route-backed runtime context

Create a shared helper that builds route-backed runtime APIs for an organisation:

```ts
createRouteBackedBackofficeToolContext({ env, orgId });
```

This replaces scattered construction such as:

- `createRouteBackedInteractiveBashContext`,
- `createPiRouteBashRuntime`,
- `createResendRouteBashRuntime`,
- `createReson8RouteBashRuntime`, etc.

It can still call those lower-level route callers internally during migration.

### Storage-backed automation context

For automation hook execution, create a context that uses storage-backed identity/event behavior
where appropriate, while still adding route-backed services for cross-fragment integrations.

## Codemode provider

`runtime-tools/codemode-provider.ts` should convert `BackofficeRuntimeTool[]` into
`@cloudflare/codemode` `ToolProvider`s.

Preferred provider shape:

```ts
[
  { name: "automations", tools: ... },
  { name: "event", tools: ... },
  { name: "otp", tools: ... },
  { name: "pi", tools: ... },
  { name: "resend", tools: ... },
  { name: "reson8", tools: ... },
  { name: "telegram", tools: ... },
]
```

Codemode tool names should be **camelCase** object APIs. They do not need to mirror the bash command
names.

Generated code should read like:

```js
async () => {
  const event = JSON.parse(await state.readFile("/context/event.json"));
  await telegram.sendMessage({ chatId: event.externalActorId, text: "Hello" });
  return { ok: true };
};
```

## Bash command provider

`runtime-tools/bash-commands.ts` should convert `BackofficeRuntimeTool[]` into `just-bash` custom
commands for tools that define a `bash` surface.

This is a breaking replacement for the current per-family `create*BashCommands` functions.

The new bash host should be simple:

```ts
createBackofficeBashHost({ fs, env, context, tools });
```

It should no longer know every module/family by hand.

## Filesystem state support

Add an adapter from backoffice `IFileSystem` / `MasterFileSystem` to `@cloudflare/shell`'s
`FileSystemStateBackend`.

Goals:

- expose `state.readFile`, `state.writeFile`, `state.planEdits`, etc. inside codemode,
- preserve existing mount behavior and read-only enforcement,
- keep `/workspace`, `/system`, `/context`, `/resend`, and other mounts intact.

This adapter should delegate all operations to the existing filesystem instead of bypassing mount
permissions.

## Dynamic worker execution

Add `worker_loaders` to `apps/backoffice/wrangler.jsonc`:

```jsonc
"worker_loaders": [{ "binding": "LOADER" }]
```

Create a shared executor helper:

```ts
runBackofficeCodemode({
  code,
  fs,
  env,
  orgId,
  context,
  tools,
  timeout,
});
```

It should:

1. create `DynamicWorkerExecutor({ loader: env.LOADER, globalOutbound: null })`,
2. adapt the current filesystem to `state.*`,
3. expose backoffice runtime tools as named providers,
4. execute the user script,
5. return a normalized result with `result`, `error`, `logs`, and tool call metadata.

## Pi agent sessions

Update Pi tool IDs:

```ts
export const PI_TOOL_IDS = ["bash", "runStateCode"] as const;
```

Pi should ship with **two default harnesses** instead of one mixed harness:

1. `bash` harness
   - exposes only the `bash` tool,
   - keeps the current shell-oriented guidance,
   - is useful for legacy automation scripts and true shell-style workflows.
2. `codemode` harness
   - exposes only `runStateCode`,
   - gives strong guidance for `state.*` and camelCase domain tools,
   - is the preferred harness for new agents and automation authoring.

Add a `runStateCode` Pi tool in `app/fragno/pi/pi.ts`.

The tool should:

- use the same session filesystem as `bash`,
- expose `state.*`,
- expose all configured backoffice domain tools,
- use `DynamicWorkerExecutor`,
- return readable text plus structured details.

Update the codemode harness system prompt to tell agents:

- use `runStateCode` for coordinated filesystem work,
- use `state.*` for multi-file operations,
- use camelCase domain providers for backoffice effects,
- do not assume `import()` is available inside the dynamic worker code,
- write codemode automation scripts as standalone async arrow functions.

## Automation scripts

Change automation manifest script engine from only bash:

```ts
engine: z.literal("bash");
```

to an **explicitly required** engine:

```ts
engine: z.enum(["bash", "codemode"]);
```

This is intentionally breaking. Existing manifests must set `engine` explicitly.

Codemode automation files should use the `*.cm.js` suffix, for example:

```txt
/workspace/automations/scripts/telegram-claim-linking.cm.js
```

The suffix makes it clear that these files are dynamic-worker codemode scripts, not general JS
modules. In particular, authors should not expect `import()` or module loading to work.

Add `executeCodemodeAutomation(...)` that mirrors `executeBashAutomation(...)` but runs dynamic
worker code.

Both bash and codemode automation execution should share:

- `/context/event.json`,
- `/dev` mount behavior if still needed for bash,
- normalized result shape.

Suggested normalized result:

```ts
export type AutomationRunResult = {
  runtime: "bash" | "codemode";
  eventId: string;
  scriptId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  logs: string[];
  result?: unknown;
  toolCalls: BackofficeRuntimeToolCall[];
};
```

`automation/definition.ts` should dispatch based on `binding.scriptEngine`:

```ts
switch (binding.scriptEngine) {
  case "bash":
    return executeBashAutomation(...);
  case "codemode":
    return executeCodemodeAutomation(...);
}
```

## Vertical slice rollout

Every slice should be independently testable and leave the app in a workable state. Avoid long
infrastructure-only phases that cannot prove value on their own.

### Slice 1: Minimal codemode execution against the backoffice filesystem

Goal: prove dynamic-worker execution and `state.*` work against the existing mounted filesystem.

Implement:

- Add `@cloudflare/codemode` and `@cloudflare/shell` to backoffice dependencies.
- Add `worker_loaders` binding to `apps/backoffice/wrangler.jsonc`.
- Regenerate Cloudflare types.
- Add the `MasterFileSystem` / `IFileSystem` adapter for `@cloudflare/shell`'s
  `FileSystemStateBackend`.
- Add `runBackofficeCodemode(...)` with only `state.*` and no domain tools.

Tests:

- Unit test the filesystem adapter for read, write, mkdir, rm, stat, read-only mount rejection, and
  basic glob behavior.
- Worker/Vitest test `runBackofficeCodemode(...)` with code that reads, writes, and returns data
  from a mounted test filesystem.
- Confirm dynamic worker execution has no direct network access by default.

### Slice 2: First runtime-aware tool family, usable from both runtimes

Goal: validate the new breaking tool definition model with one small family before migrating all
commands.

Implement:

- Add `BackofficeRuntimeTool` and `BackofficeToolContext`.
- Add codemode provider generation with camelCase tool names.
- Add bash command generation from the same definition.
- Migrate one low-risk family first, preferably `automations.identity.lookupBinding` and
  `automations.identity.bindActor`.
- Keep the old bash host available, but route this family through the new generated bash commands.

Tests:

- Definition tests validate zod input parsing and output shape.
- Codemode provider test calls `automations.lookupBinding(...)` / `automations.bindActor(...)`
  through `runBackofficeCodemode(...)`.
- Bash test calls the generated legacy commands and verifies the same semantic runtime method was
  invoked.
- Type test or snapshot verifies generated codemode names are camelCase.

### Slice 3: Pi codemode harness with filesystem-only `runStateCode`

Goal: ship a separately selectable Pi codemode harness even before every domain tool is migrated.

Implement:

- Add `runStateCode` to `PI_TOOL_IDS`.
- Split the default Pi harnesses into `bash` and `codemode` harnesses.
- Add the `runStateCode` Pi tool with `state.*` support.
- The codemode harness initially exposes `runStateCode`; the bash harness keeps `bash`.

Tests:

- Pi registry test confirms two default harnesses exist and have non-overlapping tool sets.
- Pi tool test runs `runStateCode` against a session filesystem and verifies file writes persist.
- Prompt/config test verifies the codemode harness guidance mentions `state.*`, camelCase tools, and
  no `import()` assumption.

### Slice 4: Pi codemode harness with one domain tool family

Goal: prove Pi agents can use codemode to call real backoffice domain tools.

Implement:

- Wire the Slice 2 runtime-aware tool family into Pi `runStateCode`.
- Ensure tool calls are recorded in structured details.
- Add user-facing formatting for codemode result, logs, errors, and tool calls.

Tests:

- Pi tool test runs codemode that calls the migrated domain tool family.
- Error-path test verifies zod validation errors surface clearly to the agent.
- Tool-call metadata test verifies details include provider name, tool name, input summary, and
  result/error.

### Slice 5: Codemode automation with no domain effects

Goal: run a real automation binding through the codemode runtime using only `state.*` and
`/context/event.json`.

Implement:

- Require explicit `script.engine` in the automation manifest.
- Support `engine: "codemode"` in catalog types.
- Require or validate `*.cm.js` paths for codemode scripts.
- Extract shared execution filesystem creation so bash and codemode both get `/context/event.json`.
- Add `executeCodemodeAutomation(...)` using `runBackofficeCodemode(...)`.
- Dispatch automation bindings by `scriptEngine`.

Tests:

- Catalog test rejects bindings without explicit `engine`.
- Catalog test rejects codemode script paths that do not end in `.cm.js`.
- Scenario test runs a `.cm.js` automation that reads `/context/event.json` and writes an output
  file.
- Existing bash automation tests still pass after adding explicit `engine: "bash"` to fixtures.

### Slice 6: Codemode automation with domain tools

Goal: prove automations and Pi sessions use the same domain tool definitions.

Implement:

- Expose the migrated Slice 2 tool family to codemode automations.
- Add storage-backed automation context for tools that should mutate automation state directly.
- Normalize automation results across bash and codemode into `AutomationRunResult`.

Tests:

- Scenario test runs a `.cm.js` automation that calls `automations.bindActor(...)`.
- Scenario test verifies the same tool definition works through bash and codemode.
- Failure test verifies failed codemode execution causes the durable hook to fail with a useful
  message.

### Slice 7: Migrate remaining tool families one by one

Goal: replace the bash-specific command-spec model through small, testable family migrations.

Repeat per family:

1. Move semantic runtime operations into `BackofficeRuntimeTool` definitions.
2. Provide camelCase codemode names.
3. Provide bash parse/format support where legacy bash scripts still need it.
4. Delete that family's old bespoke `create*BashCommands` path.
5. Add codemode and bash tests for the family.

Suggested order:

1. `event`
2. `otp`
3. `telegram`
4. `resend`
5. `reson8`
6. `pi`

Tests per family:

- zod input validation,
- codemode invocation,
- bash invocation,
- route-backed runtime behavior or unavailable-runtime error behavior,
- result formatting.

### Slice 8: Remove old bash-runtime architecture

Goal: complete the breaking refactor once all families have moved.

Implement:

- Replace `BASH_HOST_MODULES` with generated command registration from the runtime tool registry.
- Remove obsolete command maps and `ParsedCommandByName` types.
- Rename remaining route-backed APIs away from `BashRuntime` where they are no longer bash-specific.
- Rename `BashAutomationRunResult` to `AutomationRunResult`.
- Update starter automation files and docs to use explicit `engine` and `.cm.js` for codemode.

Tests:

- Full backoffice type-check.
- All automation scenario tests.
- Pi bash harness test.
- Pi codemode harness test.
- One end-to-end durable-object automation ingest test for bash and one for codemode.

## Settled decisions

1. Codemode provider tool names are camelCase object APIs, e.g. `telegram.sendMessage(...)`.
2. Pi ships two default harnesses: `bash` and `codemode`.
3. Automation manifests must require explicit `script.engine`.
4. Codemode automation files stay under `automations/scripts`, but must use the `*.cm.js` suffix.

## Success criteria

- A Pi session can use `runStateCode` to edit files through `state.*`.
- A Pi session can use `runStateCode` to call backoffice domain tools.
- An automation binding can run a codemode script in a dynamic worker.
- Bash and codemode use the same runtime tool definitions.
- The old bash-specific tool-definition model is removed or reduced to a generated compatibility
  layer.
