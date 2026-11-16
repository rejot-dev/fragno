# Keyed Runs

A **keyed run** is one workflow run per thing, such as per incident: the route renders the run's
instance ID from the thing's id, and an instance ID names at most one run, so the thing's later
events find its run instead of starting another. Use one for work that lasts while a thing is open,
such as triaging an incident in a sandbox or onboarding a customer.

## Steps

1. **Key the run.** Render the instance ID from the thing's id in a `start_workflow` route, such as
   `instanceIdTemplate: "triage-${event.payload.incidentId}"`. An event for a thing whose run exists
   records the route as `skipped` with `workflow_instance_exists`. Choose what a finished run does
   with `existingRun`:
   - `"keep"`, the default: the first run stays for good. Where a new run should start, such as for
     a reopened incident, put what tells them apart in the ID, such as
     `triage-${event.payload.incidentId}-${event.payload.openedAt}`.
   - `"restart_finished"`: a later event starts a complete, errored, or terminated run again,
     replacing its steps and events. A run still going stays.

   When restarting after a workflow or import edit, read **Changing a saved workflow** in
   `/static/skills/workflows/SKILL.md` before choosing the instance ID.

   **Complete when** the template renders one ID per thing and `existingRun` says whether the work
   starts again.

2. **Hold resources in the run.** A run that starts a resource, such as a sandbox, names it after
   the thing and releases it in its last step. Give a sandbox a `sleepAfter` lease too, which stops
   it should the run end before that step. Grant the route what the workflow calls, such as
   `sandbox.modify`. **Complete when** every resource the run starts is released by its last step or
   bounded by a lease.

3. **Show it.** Fire one keyed type with the thing's status at each change, such as `triage.changed`
   from the source `incidents` with `keyPath: "$.incidentId"`, so pages list each thing as it is
   now, as `/static/skills/building-automations/references/event-state.md` describes:

   ```js
   export default defineWorkflow({ name: "triage" }, async (event, step) => {
     const { incidentId } = event.payload;
     const sandboxId = `triage-${incidentId}`;
     const show = (status) =>
       events.fire({
         source: "incidents",
         eventType: "triage.changed",
         payload: { incidentId, status, sandboxId },
       });
     await step.do("start", async () => {
       await sandbox.startSandbox({ id: sandboxId, sleepAfter: "2h" });
       await show("started");
     });
     // The triage's own steps run here.
     await step.do("release", async () => {
       await sandbox.killSandbox({ sandboxId });
       await show("ended");
     });
   });
   ```

   **Complete when** each status change fires the thing's whole status.

## Whether a thing's run is going

The run is the source: `workflow.getInstance({ instanceId: "triage-INC-1" })` reports it going or
finished, even when it ended without firing `ended`. The thing's state shows the same for pages and
for many things at once, such as
`events.stateGet({ source: "incidents", eventType: "triage.changed", keys: ["INC-1"] })`; decide
from the run. A sandbox's own lifecycle is state as well, by `sandboxId`.
