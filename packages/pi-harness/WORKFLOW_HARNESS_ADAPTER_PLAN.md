# Workflow-backed AgentHarness adapter plan

## Current durable model

`@fragno-dev/pi-harness` is a thin adapter over normal `@fragno-dev/workflows` and Pi's
`AgentHarness`.

- `AgentHarness` instances are ephemeral and reconstructed inside workflow steps.
- Workflow step results and workflow step emissions are the durable source of truth for transcript
  state.
- The Pi `session` table is only a route/session index: id, workflow name, display name, selected
  harness/agent name, status, and timestamps.
- There is intentionally no `session_entry` table. `SessionTreeEntry` values live in workflow
  history:
  - in-flight entries are emitted as `harness-session-entry` step emissions
  - completed steps store the full `entries`/`leafId` state in their `harness-run` result

This avoids double-writing transcript state and prevents partial in-flight session writes from
becoming committed database state outside the workflow log.

## Runtime pieces

- `WorkflowBackedSessionStorage`
  - in-memory `SessionStorage` implementation for a single harness step
  - accepts committed entries from the workflow loop state
  - emits every appended entry through `onAppendEntry`
- `runPiHarnessStep(...)`
  - creates a fresh `AgentHarness` for a workflow step
  - subscribes to harness events and emits them as workflow step emissions
  - emits appended `SessionTreeEntry` values as workflow step emissions
  - stores the completed harness result, including full `entries` and `leafId`, as the step result
- `createAgentLoop(...)`
  - workflow-facing helper that threads session state between harness steps
  - waits for Pi commands through normal workflow events
  - exposes tools up front and uses per-step/per-command `activeToolNames` as policy

## Route projection

`getSessionDetailSnapshot(...)` reconstructs committed agent state from workflow history:

1. load the `session` row
2. load workflow status and workflow history
3. find the latest completed `harness-run` step result
4. project its `SessionTreeEntry[]` through `buildSessionContext(...)`
5. return that as the snapshot for `/sessions/:sessionId`

The live `/events` route sends that snapshot first, then streams in-flight step emissions for steps
not already represented by completed step results.

## Recovery status

Completed harness steps replay safely from workflow history and do not call the provider again.

Partial in-flight prompt-like steps also recover from workflow emissions. When a prior attempt
emitted `harness-session-entry` values without a matching `harness-operation-complete` journal,
`runPiHarnessStep(...)` reconstructs what is safe from those emitted entries:

- completed assistant messages can finish the step without rerunning the provider
- incomplete tool turns roll back before the assistant tool-call message
- attempts that only reached the user prompt are replayed from the previously committed session
  base, so the final transcript does not contain duplicate prompt entries

This recovery path still uses `AgentHarness`; it does not instantiate the lower-level `Agent`.
Because `AgentHarness` does not expose `continue()`, recovery replays prompt-like operations instead
of continuing from an already-restored user/tool-result message. This is intentionally limited to
`prompt`, `skill`, and `promptFromTemplate`. Non-turn operations such as `compact` and
`navigateTree`, and more advanced partial states ending in tool results, still fail closed if only
partial emissions are available.
