# Pi harness emission-order simplification plan

## Goal

Simplify the workflow-backed Pi `AgentHarness` by relying on the ordering and append-only guarantees
already provided by Fragno Workflows and Pi sessions.

The implementation must retain the current recovery behavior:

- preserve every durable session entry emitted before interruption;
- never repeat a completed provider request or tool execution;
- synthesize error tool results only for missing tool calls;
- represent interruption through the durable operation outcome;
- keep synthetic interruption UI markers out of model context;
- process each user-authored command exactly once as either a live control or a later prompt;
- preserve session branching, navigation, compaction, and leaf semantics.

The target is a smaller implementation with explicit trust boundaries rather than defensive merging
of states the runtime cannot legitimately produce.

## Scope and LoC baseline

This plan covers the workflow and projection integration around:

- `packages/pi-harness/src/pi/workflows/workflow-agent-harness.ts` — 874 lines;
- `packages/pi-harness/src/pi/workflows/interactive-chat-workflow.ts` — 342 lines;
- `packages/pi-harness/src/pi/workflow-session-projection.ts` — 315 lines;
- `packages/pi-harness/src/pi/session-entry-projection.ts` — 164 lines;
- `apps/backoffice/app/fragno/automation/engine/codemode-workflow-agent.ts` — 250 lines.

The current scoped production baseline is approximately 1,945 lines. LoC estimates below are net
production-code decreases after additions and deletions; they exclude regression tests. Estimates
are directional, not acceptance criteria.

Expected total production reduction: **approximately 110–210 lines**.

## Runtime guarantees to adopt

### Canonical workflow-attempt ordering

The Workflows runner already selects the replay epoch for a durable step. For normal execution,
`tx.previousEmissions()` returns emissions for that selected epoch in database order.

The harness adapter may therefore assume:

```text
one durable step
  → one selected replay epoch
  → one ordered harness-attempt journal
```

The adapter should validate this boundary and fail loudly if it receives incompatible harness
emissions. It should not independently select a winning epoch or merge competing attempts.

Tests that inject multiple epochs directly into the harness restore helper duplicate responsibility
owned by Workflows. Move those tests to the workflow replay-selection boundary or rewrite them to
exercise the real runner.

### Immutable session-entry append order

`WorkflowBackedSessionStorage` treats session entries as immutable append-log records:

- `appendEntry` rejects duplicate IDs;
- an entry's parent must already exist;
- appending updates the active leaf;
- leaf movement creates another durable entry;
- no API mutates an existing entry.

A repeated session-entry ID is therefore corruption, not an update. Recovery should reject repeated
IDs instead of replacing the earlier entry.

### Session entries precede terminal harness events

For `message_end`, `AgentHarness` appends the completed message to its `Session` before it notifies
harness subscribers. The resulting order is:

```text
harness-session-entry(message)
harness-event(message_end)
```

Partial assistant text and partial tool progress exist only in harness events. Session entries
contain completed messages and selection records.

### Tool-result messages preserve tool-call order

Tool executions may finish concurrently, but Pi appends their final `toolResult` messages in the
assistant's original tool-call order. Interrupted recovery can analyze one ordered transcript suffix
rather than reconstructing tool state through multiple independent scans.

### Session history remains a tree

Append order does not make session history flat. Navigation, compaction, and leaf records can create
or select branches. Recovery must continue to use the active branch and durable leaf rather than
assuming that the last physical entry is always the active leaf.

## Assumptions not to adopt

The simplification must not rely on the following claims:

| Unsafe assumption                                        | Reason                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `event.consume()` prevents all redelivery immediately    | Live workflow-event delivery remains at-least-once until consumption becomes durably visible.  |
| A terminal assistant proves the operation completed      | The workflow callback can transform the Pi return value into an arbitrary serializable result. |
| All session entries belong to one linear transcript      | Navigation and leaf entries preserve abandoned and alternative branches.                       |
| A repeated session-entry ID is an update                 | Session storage defines IDs as immutable and unique.                                           |
| An operation started only when a user message exists     | Execution can stop after the operation-start emission and before the first session append.     |
| Every persisted consumption marker belongs to the winner | A concurrent execution that emitted it may later lose.                                         |
| Harness events are the durable transcript                | Partial events are presentation data; session entries are the canonical completed transcript.  |

Keep operation-start and operation-complete emissions, `leafId`, active-handler draining, and
tree-aware recovery unless their owning runtime contracts change.

## Target lifecycle

The target workflow adapter owns one complete durable invocation lifecycle:

```text
step.do
  │
  ├─ readHarnessAttempt(previousEmissions)
  │    ├─ operation started?
  │    ├─ ordered session-entry suffix
  │    └─ completion checkpoint?
  │
  ├─ construct Session from committed state + attempt suffix
  │
  ├─ completion exists ───────────────→ replay exact result
  │
  ├─ operation started without completion
  │    └─ recover transcript ─────────→ checkpoint aborted result
  │
  └─ no operation started
       ├─ construct AgentHarness
       ├─ execute callback once
       └─ checkpoint completed result
```

The workflow author should provide runtime options and the Pi operation callback. The adapter should
own replay parsing, storage wiring, recovery, subscriptions, and checkpoint construction.

## Implementation plan

### - [x] Step 1: Lock the ordering contract with regression tests

**Expected production LoC decrease: 0 lines.**

Add tests before changing implementation. These tests establish which runtime guarantees later steps
may trust.

- [x] Prove that the real workflow runner supplies one selected replay epoch to a retried step.
- [x] Prove that user harness emissions retain their persisted sequence order within that epoch.
- [x] Prove that a session-entry emission precedes the corresponding `message_end` harness event.
- [x] Prove that final tool-result session messages retain original tool-call order even when tools
      complete concurrently.
- [x] Prove that duplicate session-entry IDs are rejected rather than interpreted as replacements.
- [x] Prove that initial session entries appear in the first durable checkpoint exactly once.
- [x] Prove that initial session entries are excluded from current-operation accounting.
- [x] Preserve the partial multi-tool interruption regression: real results remain unchanged and
      only missing calls receive synthetic errors.
- [x] Preserve branch and leaf regressions for navigation and interrupted recovery.
- [x] Preserve the live-control redelivery regression; do not encode exactly-once consumption as an
      ordering guarantee.

Move multi-epoch canonicalization tests out of the harness reconstruction unit and into the
Workflows replay-selection tests. Harness reconstruction tests should receive the same single-epoch
shape that `tx.previousEmissions()` provides in production.

**Exit condition:** the tests distinguish runtime-owned canonicalization from harness-owned attempt
parsing and fail if any proposed ordering guarantee is violated.

### - [x] Step 2: Replace repeated emission scans with one attempt parser

**Expected production LoC decrease: 45–70 lines.**

Introduce one semantic parser:

```ts
type HarnessAttempt<TResult> = {
  started: boolean;
  sessionEntries: SessionTreeEntry[];
  completion?: WorkflowAgentHarnessStepResult<TResult>;
};

function readHarnessAttempt<TResult>(
  emissions: readonly WorkflowStepEmission[],
  operationId: string,
): HarnessAttempt<TResult>;
```

The parser should process harness-owned emissions once in persisted order:

1. ignore system control emissions;
2. validate that all relevant emissions belong to one execution and epoch;
3. accept at most one matching operation-start emission;
4. append session entries without sorting or replacement;
5. reject repeated session-entry IDs;
6. accept at most one matching operation-complete emission;
7. require completion to be the final harness-owned emission;
8. retain no presentation-only harness events in restored session state.

Use this parser to replace the independent logic currently represented by functions such as:

- `trustedWorkflowAgentHarnessEmissions`;
- `emittedSessionEntries`;
- `completedInvocation`;
- `operationWasStarted`;
- completion-specific epoch filtering;
- duplicate-ID replacement during attempt reconstruction.

Unknown or impossible harness journal shapes should produce a focused invariant error. The adapter
should not silently repair cross-epoch or duplicate-ID input.

**Exit condition:** completed replay, fresh execution, and interrupted recovery all consume the same
`HarnessAttempt` value and no longer rescan previous emissions for separate facts.

### - [x] Step 3: Replace persisted entry-ID bookkeeping with append-log boundaries

**Expected production LoC decrease: 35–55 lines.**

Replace the durable ID array with an ordered checkpoint boundary:

```ts
type PiHarnessSessionStepState = {
  metadata: SessionMetadata;
  entries: readonly SessionTreeEntry[];
  checkpointedEntryCount: number;
};
```

Use two separate indexes during an invocation:

```text
operationEntryStart = state.entries.length
checkpointEntryStart = state.checkpointedEntryCount
```

After replay reconstruction:

```ts
const entries = [...state.entries, ...attempt.sessionEntries];
const operationEntries = entries.slice(operationEntryStart);
const checkpointEntries = entries.slice(checkpointEntryStart);
```

The indexes have different meanings:

- `operationEntryStart` excludes all pre-operation context from accounting and terminal callbacks;
- `checkpointEntryStart` includes uncheckpointed initial messages in the first durable result.

Update the reducer to validate ordered prefixes instead of merging maps:

1. identify the uncheckpointed suffix already present in state;
2. require the result checkpoint to begin with that exact suffix;
3. append only the genuinely new entries after the known suffix;
4. set `checkpointedEntryCount` to the new entry count;
5. validate that the result leaf is derivable from the resulting tree.

Delete or reduce:

- `assertPersistedEntriesBelongToSession`;
- repeated `Set<string>` construction for persisted entries;
- filters based on `persistedEntryIds`;
- replacement-oriented `mergeSessionEntries` use in restore and reduction.

Use structural entry equality only when validating the known initial suffix. A repeated ID with
different content must fail.

**Exit condition:** state and step results behave as ordered append logs, initial messages still
checkpoint once, and session history remains linear in storage size rather than quadratic.

### - [x] Step 4: Analyze interrupted transcripts in one pass

**Expected production LoC decrease: 20–40 lines.**

Combine recoverable-leaf classification and missing-tool detection:

```ts
type InterruptedTranscript = {
  recoverableLeafId: string | null;
  missingToolCalls: ToolCall[];
};

function analyzeInterruptedTranscript(
  baseLeafId: string | null,
  activeOperationBranch: readonly SessionTreeEntry[],
): InterruptedTranscript;
```

The analyzer should implement the Pi transcript grammar directly:

```text
user
  → recoverable

assistant without open tool calls
  → terminal but uncheckpointed; recover before this assistant

assistant with tool calls
  → recoverable; open the call batch

toolResult matching an open call
  → recoverable; close that call

next assistant after a closed batch
  → begin the next model turn

invalid role, duplicate result, or unmatched result
  → stop at the previous recoverable leaf
```

Recovery should then:

1. inspect the active branch once;
2. move to the recoverable leaf only when an invalid terminal suffix requires it;
3. append one `isError: true` result for each missing call;
4. preserve every real tool result byte-for-byte;
5. return an aborted outcome anchored at the recovered leaf.

Replace or collapse:

- `recoverableLeafForInterruptedOperation`;
- `assistantToolCallIds`;
- `missingToolCallsInSessionContext`;
- the second context traversal after leaf analysis.

Do not analyze the physical append log as if it were the active branch. Continue to derive the
operation branch from the session tree and selected leaf.

**Exit condition:** interrupted recovery performs one transcript analysis and retains the existing
provider/tool non-replay guarantees.

### - [x] Step 5: Consolidate the restored lifecycle without owning harness construction

**Expected production LoC decrease: 0–20 lines.**

Keep normal Pi construction under the workflow author's control:

```ts
const restored = restoreWorkflowBackedSession({
  operationId,
  state: sessionState,
  previousEmissions: await tx.previousEmissions(),
  models: harnessOptions.models,
});

const harness = new AgentHarness({
  ...harnessOptions,
  ...restored.options,
});

const result = await withWorkflowAgentHarness({
  restored,
  harness,
  tx,
  runDurableStep: () => harness.prompt(input),
  observeLiveEvents,
  onTerminalOutcome,
});
```

`restoreWorkflowBackedSession` owns:

1. parsing the selected attempt journal;
2. constructing workflow-backed storage and Pi's `Session`;
3. classifying completed, interrupted, and fresh attempts;
4. deriving model, thinking-level, and active-tool overrides from the selected branch;
5. returning one restored lifecycle value consumed by `withWorkflowAgentHarness`.

The workflow author owns `new AgentHarness(...)`. This preserves normal constructor configuration,
custom subclasses or factories, tools, resources, hooks, and other Pi extension points.

`withWorkflowAgentHarness` owns:

1. wiring storage appends and compact harness events to workflow emissions;
2. replaying completed checkpoints without running the callback;
3. recovering interrupted attempts without invoking provider or tool work;
4. emitting operation start and operation completion;
5. delivering and draining live event handlers;
6. invoking the terminal observer with exact operation entries;
7. removing subscriptions in `finally`.

Harness construction during completed replay or interrupted recovery is acceptable: construction is
caller-owned setup and must not itself perform provider or tool work. The adapter still guarantees
that the operation callback, provider request, and completed tools do not rerun.

**Exit condition:** workflow authors construct `AgentHarness` directly, while restore and execution
plumbing remain explicit, ordered, and difficult to miswire.

### - [x] Step 6: Move live-control delivery deduplication to its owning boundary

**Expected production LoC decrease: 15–30 lines.**

Do not delete command-ID bookkeeping by assuming that `event.consume()` immediately prevents
redelivery. First establish a stronger generic contract.

Preferred Workflows-level contract:

```text
live event delivered through tx.onEvent
  → handler calls event.consume()
  → enclosing durable step succeeds
  → a later waitForEvent in the same workflow passage cannot return that event
```

The contract must also preserve losing-execution recovery:

```text
execution A consumes the event but loses
  → execution B or a later recovery can still receive the event
```

Implement this at the workflow event-consumption boundary, not in Pi command routing. Add runner
regressions for:

- live consumption followed immediately by `waitForEvent`;
- consumption racing step completion;
- interrupted execution recovery;
- concurrent winner and loser execution attempts;
- redelivery after a losing execution's noncanonical consumption.

After the core guarantee exists, remove:

- `operationDeliveredControlCommandIds`;
- `deliveredControlCommandIds`;
- `InteractiveChatHarnessStepResult.deliveredControlCommandIds`;
- terminal-outcome mutation used only to persist command IDs;
- replay reconstruction of handled command IDs.

If the core guarantee is too broad for this refactor, use an intermediate generic mechanism:

1. expose the workflow event ID from `waitForEvent`;
2. record consumed event IDs in the generic harness adapter;
3. persist those IDs in the generic step result;
4. deduplicate by workflow event ID rather than command-specific metadata.

That intermediate design should still remove operation-local command bookkeeping from the
interactive workflow.

**Exit condition:** command routing expresses only policy—active `steer`, active `followUp`, idle
fallback, and idle `abort`—while generic workflow infrastructure owns redelivery handling.

**Implementation note:** successful live consumption now updates both the durable event mutation and
the runner's current-passage event snapshot. A following `waitForEvent` therefore cannot select the
same event. Interrupted, failed, and proven losing executions still redeliver. Pi no longer persists
command IDs in harness step results.

### - [x] Step 7: Remove obsolete helpers and tighten protocol comments

**Expected production LoC decrease: 10–20 lines.**

Perform a final cleanup after callers migrate:

- [x] Delete private helpers replaced by the ordered attempt parser.
- [x] Delete ID-map merging helpers replaced by append-log boundaries.
- [x] Delete duplicate recovery scans replaced by `analyzeInterruptedTranscript`.
- [x] Delete compatibility wrappers for the old restore/execute assembly path.
- [x] Remove comments describing cross-epoch normalization inside the harness adapter.
- [x] Document the single-epoch and append-only assumptions at their trust boundaries.
- [x] Keep comments that explain crash windows, arbitrary callback result recovery, tree semantics,
      and at-least-once live events.
- [x] Re-run result-size tests and update expectations only when the reduction comes from removed
      durable metadata rather than lost transcript state.

Do not remove these protocol fields in this plan:

- `harness-operation-start`;
- `harness-operation-complete`;
- `WorkflowAgentHarnessStepResult.outcome`;
- `WorkflowAgentHarnessStepResult.leafId`;
- durable session-entry emissions;
- the projected aborted assistant marker.

They still represent real recovery, projection, accounting, or arbitrary-result boundaries.

**Exit condition:** each remaining helper owns one semantic responsibility, comments describe the
current design, and no compatibility-only path remains.

**Implementation note:** the test-only restore/execute compatibility wrapper was removed and tests
now use the production `restoreWorkflowBackedSession` and `withWorkflowAgentHarness` boundary
directly.

## Expected LoC result

| Step                                    | Expected production LoC decrease |
| --------------------------------------- | -------------------------------: |
| 1. Lock ordering contracts              |                                0 |
| 2. One attempt parser                   |                            45–70 |
| 3. Append-log boundaries                |                            35–55 |
| 4. One interrupted transcript analyzer  |                            20–40 |
| 5. Caller-constructed harness lifecycle |                             0–20 |
| 6. Generic live-control deduplication   |                            15–30 |
| 7. Final helper and comment cleanup     |                            10–20 |
| **Expected total**                      |                      **125–235** |

The total overlaps slightly between steps because deleting one helper may become possible through
more than one refactor. Use **110–210 net production lines** as the realistic planning range.

Actual scoped production result:

```text
workflow-agent-harness.ts       874 → 808  (-66)
interactive-chat-workflow.ts    342 → 316  (-26)
workflow-session-projection.ts  315 → 315    (0)
session-entry-projection.ts     164 → 164    (0)
Codemode adapter                250 → 245   (-5)

scoped production total        1,945 → 1,848  (-97)
```

The Workflows-level consumption fix adds six production lines outside the original scope, for a net
repository production change of **-91 lines**. Test LoC increased intentionally to make ordering,
recovery, event races, and losing-execution behavior explicit.

## Verification checklist

- [x] All `@fragno-dev/pi-harness` tests pass.
- [x] Pi harness type-check passes.
- [x] Pi harness build passes.
- [x] Backoffice type-check passes.
- [x] Backoffice assistant-runtime tests pass.
- [x] Workflow runner event-consumption regressions pass.
- [x] No completed provider call runs twice during restart scenarios.
- [x] No completed tool runs twice during restart scenarios.
- [x] Real tool results survive byte-for-byte.
- [x] Only missing tool calls receive synthetic error results.
- [x] Aborted recovery appends no synthetic assistant or custom interruption entry.
- [x] The UI still derives one `Response stopped` marker from durable outcome.
- [x] Real Pi assistants with `stopReason: "aborted"` are not duplicated.
- [x] Initial messages appear once in durable projection and never in current-operation accounting.
- [x] Active and idle `steer` and `followUp` commands satisfy exactly-one handling.
- [x] Idle `abort` remains a no-op.
- [x] Session navigation, compaction, model selection, thinking-level selection, and active tools
      survive reconstruction.
- [x] Accounting and result-size tests pass without scanning unrelated workflow steps.
- [x] Oxlint passes.
- [x] Oxfmt passes.
- [x] `git diff --check` passes.

## Final design constraints

The completed refactor should preserve these rules:

```text
Workflows owns canonical execution selection.
The harness adapter owns one selected attempt journal.
Pi Session owns transcript and tree semantics.
Operation completion owns arbitrary callback result recovery.
Projection owns the visual interruption marker.
Workflow event infrastructure owns delivery and consumption semantics.
```

The adapter should validate these boundaries rather than recreate them. Stronger assumptions are
valuable only when the component that owns the guarantee also owns the tests that prove it.
