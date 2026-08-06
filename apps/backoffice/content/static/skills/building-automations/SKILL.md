---
name: building-automations
description:
  "Automate persistent Backoffice behavior from events or schedules. Use when the user explicitly
  asks to create or change an automation, event-triggered route, scheduled route, or saved workflow
  that should run later."
---

# Building Automations

Treat every automation as a route with one **trigger → action**. Event triggers select catalog
events; scheduled triggers own their cadence. The action starts or signals a saved workflow or
forwards the event.

## Required process

1. Read the live declarations before editing:
   - "/static/codemode/providers/events.d.ts" for the event catalog;
   - "/static/codemode/providers/router.d.ts" for route schemas and actions;
   - "/static/codemode/workflow-authoring.d.ts" when saving a workflow;
   - "/static/codemode/providers/store.d.ts" only when durable key/value coordination is needed.

   Then inspect the event descriptor and existing artifacts:

   ```js
   async () => {
     const catalog = await events.catalogList({});
     const eventDescriptor = await events.catalogGet({
       source: "telegram",
       eventType: "message.received",
     });
     const routes = await router.list({});
     const workflowFiles = await state.find("/workspace/automations", {
       type: "file",
       maxDepth: 2,
     });
     return { catalog, eventDescriptor, routes, workflowFiles };
   };
   ```

   **Complete when** the exact catalog `source` and `eventType`, relevant existing routes and
   workflow files are known.

2. Choose the smallest topology that satisfies the request:
   - External or product event: route with an `event` trigger.
   - Time-based trigger: route with a `schedule` trigger.
   - New work: `start_workflow`.
   - Resume waiting work: `send_workflow_event`.
   - Cross-scope delivery: `forward_event`.

   Use stable, namespaced ids. For `start_workflow`, make `remoteWorkflowName` equal the saved
   `defineWorkflow` name and make `workflowScriptPath` point to that file. Do not supply
   `workflowName`; Backoffice always runs saved scripts through its fixed automation workflow host.
   **Complete when** every trigger, action, saved workflow name, file path, and instance-id template
   has one unambiguous value.

3. Check prerequisites. When an external capability is involved, inspect it with
   `connections.get({ id })`. If configuration is incomplete, use the Configuring Connections skill
   and collect the missing values from the user. **Complete when** every provider the automation
   will call is configured or the user has been told exactly what remains missing.

4. Create the required artifacts in dependency order: saved workflow, then route.

   Save workflow implementations in `/workspace/automations/` with a `.workflow.js` suffix:

   ```js
   async () => {
     const path = "/workspace/automations/telegram-hello.workflow.js";
     await state.writeFile(
       path,
       `defineWorkflow(
   { name: "telegram-hello" },
   async (event, step) => {
    return await step.do("capture-event", async () => {
      return { receivedEventId: event.id };
    });
   },
   );
   `,
     );
     return { path };
   };
   ```

   Create scheduled routes with an explicit IANA time zone:

   ```js
   async () =>
     await router.create({
       id: "daily-digest",
       name: "Daily digest",
       trigger: {
         kind: "schedule",
         cadence: {
           kind: "cron",
           expression: "0 9 * * 1-5",
           timeZone: "America/New_York",
         },
       },
       action: {
         kind: "start_workflow",
         remoteWorkflowName: "daily-digest",
         workflowScriptPath: "/workspace/automations/daily-digest.workflow.js",
         instanceIdTemplate: "daily-digest-${event.id}",
       },
     });
   ```

   Create event-triggered routes with the `router` provider:

   ```js
   async () => {
     return await router.create({
       id: "telegram-hello",
       name: "Telegram hello",
       trigger: {
         kind: "event",
         source: "telegram",
         eventType: "message.received",
         matcher: { path: "$.payload.text", op: "startsWith", value: "/hello" },
       },
       priority: 1000,
       action: {
         kind: "start_workflow",
         remoteWorkflowName: "telegram-hello",
         workflowScriptPath: "/workspace/automations/telegram-hello.workflow.js",
         instanceIdTemplate: "telegram-hello-${event}",
       },
     });
   };
   ```

   For `send_workflow_event`, omit `workflowName` because the fixed automation workflow host handles
   it, and set `remoteWorkflowName` to the saved `defineWorkflow` name that owns the target
   instance. Use `{ kind: "instance_id", template }` when the event can render the workflow instance
   id directly. Use `{ kind: "stored_instance_id", keyTemplate }` when a prior run stored the
   instance id under a rendered store key. **Complete when** every required artifact has been
   created or updated successfully.

5. Use the automation store only for small durable coordination values. Values are strings,
   structured values use `JSON.stringify`, and keys are stable and namespaced. Store inputs contain
   domain data only; trusted execution provenance is recorded by the kernel. Categories are ordinary
   labels. Use `verification` for JSON text that must satisfy a schema.

6. Re-read the completed route with `router.get({ id })` and `state.readFile(workflowScriptPath)`
   when saved. Run `connections.verify({ id })` for external providers. **Complete only when** the
   route trigger, action, workflow name, file path, and connection status all line up end to end.

Legacy `router.cm.js` files are outside this topology. Database-backed router rules are the routing
source of truth; saved workflow files contain the behavior.
