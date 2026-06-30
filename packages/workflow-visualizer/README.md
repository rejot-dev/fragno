# @fragno-dev/workflow-visualizer

Static graph builder for Backoffice automations. It reads automation source files and produces a
serializable graph that UI surfaces can render as a pipeline: events → router rules → workflows →
durable steps.

The package does **not** execute user code. It parses JavaScript/TypeScript with Babel, extracts the
shapes it can prove statically, and returns diagnostics for syntax and wiring problems.

## What it understands

- Event catalog entries supplied by the caller.
- Router files such as `router.cm.js`:
  - `workflow.createInstance({ remoteWorkflowName: "..." })`
  - `workflow.sendEvent({ type: "..." })`
  - simple branch matches like `event.source === "telegram"` and
    `event.eventType === "message.received"`
- Workflow files such as `*.workflow.js`:
  - `defineWorkflow({ name: "..." }, async (event, step) => { ... })`
  - `defineRemoteWorkflow(...)`
  - raw codemode workflow expressions used by `execCodeMode`
- Durable workflow structure:
  - `step.do(...)`
  - `step.sleep(...)`
  - `step.sleepUntil(...)`
  - `step.waitForEvent(...)`
  - loops as grouping nodes when they contain steps
  - simple early-return guards as `guard` steps
- Statically analyzable Zod input schemas on `defineWorkflow({ schema: z.object(...) })`.

## Mental model

The visualizer has three layers:

1. **Parser layer** (`src/parse/*`)
   - `parse/ast.ts` wraps Babel parsing and common AST helpers.
   - `parse/router.ts` extracts router decision nodes from automation router scripts.
   - `parse/workflow.ts` extracts workflow, loop, and step nodes from workflow scripts.

2. **Build layer** (`src/build.ts`)
   - Turns a set of parsed files plus an event catalog into one `WorkflowGraph`.
   - Adds event nodes from the catalog.
   - Adds file contributions from router/workflow/script files.
   - Resolves cross-file edges:
     - catalog event → router rule (`matches`)
     - router rule → workflow (`spawns`)
     - router `sendEvent` → waiting workflow (`sends`)
   - Emits diagnostics for missing targets, unknown events, duplicate workflows, and parse errors.

3. **Interpreter layer** (`src/interpreter.ts`)
   - Keeps a mutable in-memory set of files.
   - Rebuilds the graph after each update.
   - Emits graph patches (`node.upsert`, `edge.remove`, `diagnostics.set`, etc.) for live UIs.
   - Returns full snapshots for initial load or reconnects.

`src/select.ts` provides view helpers on top of the full graph: list workflows for a selector, or
focus the graph on one workflow while keeping relevant inputs and diagnostics.

## Basic usage

```ts
import { createInterpreter, listWorkflows, selectWorkflow } from "@fragno-dev/workflow-visualizer";

const interpreter = createInterpreter();

interpreter.setEventCatalog([
  {
    source: "telegram",
    eventType: "message.received",
    label: "Telegram message received",
  },
]);

interpreter.updateFile(
  "/workspace/automations/router.cm.js",
  `
if (event.source === "telegram" && event.eventType === "message.received") {
  await workflow.createInstance({ remoteWorkflowName: "reply-to-message" });
}
`,
);

interpreter.updateFile(
  "/workspace/automations/reply-to-message.workflow.js",
  `
defineWorkflow({ name: "reply-to-message" }, async (event, step) => {
  await step.do("send reply", async () => ({ ok: true }));
});
`,
);

const graph = interpreter.snapshot();
const workflows = listWorkflows(graph);
const focused = selectWorkflow(graph, "reply-to-message");
```

## One-shot graph building

For callers that already have all files, use `build` directly:

```ts
import { build } from "@fragno-dev/workflow-visualizer";

const graph = build({
  catalog: [],
  files: new Map([
    [
      "/workspace/automations/example.workflow.js",
      {
        kind: "workflow",
        engine: "codemode",
        enabled: false,
        source: `defineWorkflow({ name: "example" }, async (event, step) => {
          await step.do("work", async () => true);
        });`,
      },
    ],
  ]),
});
```

For transient `execCodeMode` snippets, use `buildCodemodeWorkflowGraph(code, { name })`. It wraps
the snippet as a single virtual workflow file and runs the normal build pipeline.

## Live UI usage

`createInterpreter().onPatch(listener)` is intended for editor/workbench UIs:

```ts
const unsubscribe = interpreter.onPatch((patch) => {
  // Apply patch to UI state, or refetch interpreter.snapshot() after a reset.
});

interpreter.updateFile(path, newSource, { engine: "codemode" });
```

A new subscriber immediately receives a `reset` patch with the current graph, then incremental
patches after each file change.

## Graph shape

The public model is defined in `src/model.ts` and is plain JSON:

- `WorkflowGraph`: `{ version, nodes, edges, diagnostics }`
- Node kinds: `event`, `router`, `script`, `workflow`, `loop`, `step`
- Edge kinds: `matches`, `spawns`, `contains`, `sequence`, `sends`, `waits`, `emits`
- Diagnostics include a stable `code` when possible and optional source refs.

Because the model is serializable, server routes can build graphs and send them directly to browser
components.

## Static-analysis limits

The visualizer intentionally stays conservative and obvious:

- It only resolves static string names for workflow targets, event types, step labels, and workflow
  names.
- Dynamic `remoteWorkflowName`, dynamic event predicates, and referenced schemas may show as missing
  or unknown.
- It does not execute or typecheck automation code.
- Loops are structural groups, not expanded runtime iterations.
- Code inside `step.do(...)` callbacks is treated as step implementation details, not workflow
  structure.

These limits are useful guardrails: when the graph cannot prove a relationship, it emits a
diagnostic rather than guessing.

## Development

```sh
pnpm exec turbo test --filter=@fragno-dev/workflow-visualizer --output-logs=errors-only
pnpm exec turbo types:check --filter=@fragno-dev/workflow-visualizer --output-logs=errors-only
pnpm exec turbo build --filter=@fragno-dev/workflow-visualizer --output-logs=errors-only
```

Key test files:

- `src/interpreter.test.ts` — parser/build behavior and live patching.
- `src/select.test.ts` — workflow focusing and diagnostics retention.
- `src/default-workflows.test.ts` — coverage for Backoffice starter automation shapes.
