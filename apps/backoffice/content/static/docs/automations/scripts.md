# About automation scripts and workflows

Automation source files provide executable behavior, but not every source file has the same
lifecycle. Backoffice distinguishes between immediate scripts and durable workflow definitions by
file name and by how the caller executes them.

## Source layers

The automation catalog reads three file-system roots:

| Layer     | Root                     | Ownership                                                           |
| --------- | ------------------------ | ------------------------------------------------------------------- |
| Static    | `/static/automations`    | Product-owned content bundled with Backoffice.                      |
| System    | `/system/automations`    | System-managed content generated for the deployment.                |
| Workspace | `/workspace/automations` | Scope-local content authored for an organisation, project, or user. |

The catalog recursively discovers files under these roots. It exposes a single relative `path` for
display and an `absolutePath` for loading. A catalog identity also includes the layer, derived key,
version, and path so files with similar names remain distinguishable.

Workspace files are the normal authoring target. Static and system files supply built-in behavior.
The file-system mount determines whether a file can be changed; authoring helpers always resolve new
files into `/workspace/automations` and reject system paths explicitly.

## File names select the source role

Backoffice uses suffixes as conventions:

| Suffix           | Role                        | Execution model                                                          |
| ---------------- | --------------------------- | ------------------------------------------------------------------------ |
| `.workflow.js`   | Durable workflow definition | Executed through Fragno Workflows and the shared codemode workflow host. |
| `.cm.js`         | Immediate codemode script   | Compiled into an isolated dynamic Worker with Backoffice tool providers. |
| Any other suffix | Immediate Bash script       | Executed by the Backoffice Bash host.                                    |

A `.workflow.js` file is excluded from immediate script execution in the catalog. Its durable
workflow role takes precedence over the immediate engine inferred from the filename.

The catalog does not restrict discovery to these suffixes. Every discovered file becomes a catalog
entry, so automation roots should contain automation source rather than unrelated files.

## Plain scripts execute immediately

An immediate script runs once against a supplied automation event. The host adds a read-only
`/context` mount containing:

```text
/context/event.json
```

The file contains the complete automation event envelope, including scope, source, event type,
payload, actors, and subject. The execution file system also provides `/dev/null` and `/dev/zero`
without modifying the shared master file system.

Bash scripts run through the Backoffice Bash host. Codemode scripts compile and run in an isolated
Cloudflare dynamic Worker. Codemode receives generated providers for the file system, Backoffice
tools, scoped tools, configured integrations, and available MCP servers. Outbound `fetch()` depends
on the runtime's outbound policy; callers can explicitly seal network access.

Immediate scripts are an execution primitive, not the source of routing truth. Database-backed
routes decide which durable automation actions respond to events and schedules.

## Workflow files define durable behavior

A workflow file evaluates to a function or a `defineWorkflow` definition. The usual form is:

```js
defineWorkflow({ name: "project-files-configure" }, async (event, step) => {
  const automationEvent = event.payload.automationEvent;

  return await step.do("configure project files", async () => {
    return await internal.projectFilesConfigure({
      projectId: automationEvent.subject.projectId,
    });
  });
});
```

The outer workflow event belongs to the shared Backoffice workflow host. The original automation
event is available as `event.payload.automationEvent` and at `/context/event.json`.

Durable operations belong inside workflow steps:

- `step.do` records non-deterministic work and side effects.
- `step.sleep` and `step.sleepUntil` suspend until a durable time boundary.
- `step.waitForEvent` suspends until a matching workflow event arrives or a timeout expires.

Step names form part of workflow history and replay identity. They should remain stable after
instances exist.

## One shared host runs all saved workflows

Routes do not register each file as a separate local workflow. Every `start_workflow` action creates
an instance of the fixed local workflow named `automation-codemode-script`.

The route supplies two values that identify the saved behavior:

- `workflowScriptPath` points to the source file.
- `remoteWorkflowName` identifies the `defineWorkflow` definition inside that file.

The shared host reads the file from the automation file system, creates the scoped Backoffice tool
context, and executes the selected remote workflow definition. If the file no longer exists, the
host completes with a skipped result rather than attempting unrelated work:

```json
{
  "skipped": true,
  "reason": "workflow-script-not-found",
  "workflowScriptPath": "/workspace/automations/example.workflow.js"
}
```

This indirection lets the workflow service persist instances under one stable host while the UI and
router continue to identify the authored workflow by file path and definition name.

## Manual runs and routed runs use different authority

The automation UI can start a workflow manually. It creates a synthetic automation event and uses
delegated-user authority, so the current user remains the principal.

A routed run uses the authority mode stored in the route action. It also derives its instance ID
from the route template. Both paths ultimately create an `automation-codemode-script` instance with
the source path and original automation event in its parameters.

## Catalog and authoring validation

The authoring path validates candidate source before writing it:

1. Load the complete automation catalog.
2. Add or replace the candidate file in the workflow visualizer interpreter.
3. Build a workflow graph using the known event catalog.
4. Collect diagnostics and workflow summaries.
5. Refuse the write when the candidate file has an error-level diagnostic.

Errors in other catalog files remain visible but do not block an unrelated write. A successful
validation reports the file's engine, role, read-only state, workflow names, step counts, and step
labels.

Validation describes the source graph; it does not create a route. A workflow file remains dormant
until a route, manual run, or workflow API call starts it.

## Source visibility

The Backoffice UI presents layers according to the selected scope:

- System scope shows system scripts.
- Organisation scope shows static and workspace scripts.
- Project and user scopes show workspace scripts.

The runtime still resolves an explicit absolute path through the scoped master file system. Route
configuration should therefore store the intended absolute path instead of relying on a
display-relative path.

## Related documents

- [About automations](README.md)
- [Router](router.md)
- [Triggers and schedules](triggers-and-schedules.md)
- [File system](../file-system.md)

## Implementation map

- `apps/backoffice/app/fragno/automation/catalog.ts` — roots, discovery, classification, and catalog
  identities.
- `apps/backoffice/app/fragno/automation/authoring.ts` — validation and writes.
- `apps/backoffice/app/fragno/automation/engine/automation-codemode-workflow.ts` — shared
  file-backed workflow host.
- `apps/backoffice/app/fragno/automation/engine/codemode.ts` — immediate and workflow codemode
  execution.
- `apps/backoffice/app/fragno/runtime-tools/automation-host.ts` — immediate Bash and codemode
  dispatch.
- `apps/backoffice/app/fragno/automation/engine/execution-file-system.ts` — `/context` and `/dev`
  mounts.
- `apps/backoffice/app/fragno/codemode/workflow-execute.ts` — remote workflow sandbox.
- `apps/backoffice/app/routes/cadence/workflow-graph.server.ts` — graph preview and manual runs.
