# @fragno-dev/workflow-visualizer-tokens

Incremental workflow visualization for incomplete automation source.

Unlike the previous Babel-based implementation, this package does not require a valid AST. It uses
[`js-tokens`](https://github.com/lydell/js-tokens) and composable workflow-specific submachines.
Every consumed token produces a usable graph snapshot, construction state, and graph patches.

## What it recognizes

- `defineWorkflow(...)` and `defineRemoteWorkflow(...)`
- Static workflow names
- Workflow callback step parameters
- `step.do(...)`
- `step.sleep(...)`
- `step.sleepUntil(...)`
- `step.waitForEvent(...)`
- Early-return, final-return, and thrown-error terminal nodes
- Nested `if`, `else`, `else if`, and ternary control-flow containers around durable steps
- `for (...)` and `while (...)` loop containers
- `Promise.all(...)`, `Promise.race(...)`, and `Promise.any(...)` parallel branch containers
- Durable steps nested inside other step callbacks
- Exact static member calls made directly by durable step callbacks
- Explicit and concise-arrow return values from `step.do` callbacks
- Static step labels, durations, event types, timeouts, and guard reasons
- Exact path, offset, line, and column ranges for every graph node
- Local `const` reference aliases and equality predicates inside workflow conditions
- Specific event guards derived from condition fallthrough and abrupt terminal branches

The root machine handles token positions, construct discovery, and graph materialization. Active
constructs are independent `TokenSubmachine` implementations:

- `WorkflowDefinitionMachine`
- `StepCallMachine`
- `ParallelCallMachine`
- `IfStatementMachine`
- `ConditionalExpressionMachine`
- `LoopStatementMachine`
- `ReturnStatementMachine`
- `ThrowStatementMachine`

`TokenSubmachineRuntime` sends each token child-first and propagates child completion to its parent.
This allows an `else if` machine, for example, to complete its enclosing `else` branch without
putting that grammar in the root coordinator.

The graph is a control-flow tree rather than a flat list with condition annotations:

- workflows, steps, terminals, conditions, loops, parallel groups, and branches are graph nodes;
- every non-workflow node has a structural `parentId`;
- an `if` without an `else` owns its executable children directly, so a guard is simply
  `condition → terminal`;
- an `if` with an `else` owns explicit `then` and `else` branch nodes;
- returns inside active conditions are `early-return` terminals, unconditional workflow returns are
  `final-return` terminals, and throws are `error` terminals;
- a loop owns the durable structure in its body;
- a Promise combinator owns one branch node per array element;
- `order` is sibling-relative, while `sourceOrder` preserves global discovery order;
- sequence edges connect siblings that execute in order, but never alternative condition or parallel
  branches;
- every node has a `SourceRange` that selects the represented source construct;
- completed conditions contain normalized semantic outcomes for their `then`, `else`, and
  fallthrough paths;
- durable steps contain source-ranged call references in `step.analysis.invocations`, allowing a
  separate application-specific linker to identify runtime tools without coupling this package to
  those tool definitions;
- `step.do` nodes contain every direct callback return in `step.analysis.returns`, including whether
  it used an explicit `return` statement or concise-arrow syntax. Returns from ordinary nested
  callbacks are excluded, while nested durable steps own their own return values.

The semantic pass deliberately supports a small, exact expression language instead of pretending to
be a JavaScript or TypeScript checker. It resolves local `const` aliases made from member references
and understands literals, member access, equality, inequality, `!`, `&&`, `||`, and parentheses.
Unsupported conditions retain their structural graph node with `analysis.status: "unsupported"`.

For example, an early-return condition that rejects every event except `pi:capability.configured`
receives a `specific-event-guard` annotation. Its accepted fallthrough predicate is normalized to
equality facts, and an alias such as `automationEvent` resolves back to
`event.payload.automationEvent`.

The state machine still excludes implementation details from the control-flow tree when they do not
contain durable workflow structure. For example, an `if` inside a step callback is removed when it
contains no nested durable step. Exact member calls made directly by the step callback remain as
step annotations rather than becoming graph nodes. Calls inside deeper ordinary function callbacks
are excluded, and a nested durable step owns its own calls.

## Token-at-a-time usage

```ts
import {
  createWorkflowTokenMachine,
  tokenizeWorkflowSource,
} from "@fragno-dev/workflow-visualizer-tokens";

const source = `defineWorkflow({ name: "reply" }, async (event, step) => {
  await step.do("send reply", async () => {});
});`;
const machine = createWorkflowTokenMachine({
  path: "automations/reply.workflow.js",
});

for (const token of tokenizeWorkflowSource(source)) {
  const update = machine.push(token);

  renderGraph(update.graph);
  applyGraphPatches(update.patches);
  showConstructionState(update.state);
}

const final = machine.finish();
```

`push()` returns:

- `graph`: the complete visualization currently known
- `patches`: node, edge, and diagnostic changes caused by the token
- `state`: token count, source length, delimiter depth, open lexical token, and active constructs

Node ids are based on source path and discovery order, so learning a workflow name or step label
does not replace the node. It produces an upsert for the same id.

## One-shot usage

```ts
import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

const { graph, state } = visualizeWorkflowSource(
  "automations/reply.workflow.js",
  `defineWorkflow({ name: "reply" }, async (event, step) => {
    await step.do("send reply",
  `,
);
```

The unfinished workflow and step are still present. Their `construction.status` is `"partial"`, and
the unclosed string is surfaced in `state.openToken`.

## Text visualization

```ts
import {
  renderWorkflowMachineDebugText,
  renderWorkflowVisualizationText,
} from "@fragno-dev/workflow-visualizer-tokens";

console.log(renderWorkflowVisualizationText({ graph, state }));
console.debug(renderWorkflowMachineDebugText({ graph, state }));
```

The normal renderer includes workflow structure, branch conditions, step metadata, and diagnostics.
Completed constructs have no status suffix; partial constructs retain phases such as `[body]` and
`[labeled]`. The separate debug renderer shows token counts, delimiter depth, internal ids, and the
active submachine hierarchy.

## Incremental source editors

The machine consumes lexical tokens incrementally. When an editor changes characters inside an
existing token, tokenize the new source and create a new machine. When tokens are appended—as in a
streaming code generator—the existing machine can consume them directly.

## Development

```sh
pnpm exec turbo test --filter=@fragno-dev/workflow-visualizer-tokens --output-logs=errors-only
pnpm exec turbo types:check --filter=@fragno-dev/workflow-visualizer-tokens --output-logs=errors-only
pnpm exec turbo build --filter=@fragno-dev/workflow-visualizer-tokens --output-logs=errors-only
```

The tests consume every token prefix of the Backoffice starter, static, and system automation
fixtures and assert that every intermediate graph remains structurally usable. They also keep all 64
workflow definitions from `fragment-workflows/src/scenario-runner.test.ts` as explicit source
fixtures. Each scenario has an inline text snapshot covering Promise combinators, restarts,
timeouts, events, retries, and nested steps without parsing another test file at runtime.
