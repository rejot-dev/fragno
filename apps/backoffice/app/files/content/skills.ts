import type { FileContent } from "../interface";
import { GENERATING_BACKOFFICE_UIS_SKILL_CONTENT } from "./generating-backoffice-uis-skill";

const starterSkill = ({
  name,
  title,
  description,
  body,
}: {
  name: string;
  title: string;
  description: string;
  body: string;
}): Record<string, FileContent> => ({
  [`skills/${name}/SKILL.md`]: `---
name: ${name}
description: ${JSON.stringify(description)}
---

# ${title}

${body.trim()}
`,
});

export const GENERAL_SKILL_CONTENT: Record<string, FileContent> = {
  ...GENERATING_BACKOFFICE_UIS_SKILL_CONTENT,
  ...starterSkill({
    name: "building-automations",
    title: "Building Automations",
    description:
      "Automate persistent Backoffice behavior from events or schedules. Use when the user explicitly asks to create or change an automation, event-triggered route, scheduled route, or saved workflow that should run later.",
    body: `Treat every automation as a route with one **trigger → action**. Event triggers select catalog events; scheduled triggers own their cadence. The action starts or signals a saved workflow or forwards the event.

## Required process

1. Read the live declarations before editing:
   - "/static/codemode/providers/events.d.ts" for the event catalog;
   - "/static/codemode/providers/router.d.ts" for route schemas and actions;
   - "/static/codemode/workflow-authoring.d.ts" when saving a workflow;
   - "/static/codemode/providers/store.d.ts" only when durable key/value coordination is needed.

   Then inspect the event descriptor and existing artifacts:

   \`\`\`js
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
   \`\`\`

   **Complete when** the exact catalog \`source\` and \`eventType\`, relevant existing routes and workflow files are known.

2. Choose the smallest topology that satisfies the request:
   - External or product event: route with an \`event\` trigger.
   - Time-based trigger: route with a \`schedule\` trigger.
   - New work: \`start_workflow\`.
   - Resume waiting work: \`send_workflow_event\`.
   - Cross-scope delivery: \`forward_event\`.

   Use stable, namespaced ids. For \`start_workflow\`, make \`remoteWorkflowName\` equal the saved \`defineWorkflow\` name and make \`workflowScriptPath\` point to that file. Do not supply \`workflowName\`; Backoffice always runs saved scripts through its fixed automation workflow host. **Complete when** every trigger, action, saved workflow name, file path, and instance-id template has one unambiguous value.

3. Check prerequisites. When an external capability is involved, inspect it with \`connections.get({ id })\`. If configuration is incomplete, use the Configuring Connections skill and collect the missing values from the user. **Complete when** every provider the automation will call is configured or the user has been told exactly what remains missing.

4. Create the required artifacts in dependency order: saved workflow, then route.

   Save workflow implementations under \`/workspace/automations/*.workflow.js\`:

   \`\`\`js
   async () => {
     const path = "/workspace/automations/telegram-hello.workflow.js";
     await state.writeFile(
       path,
       'defineWorkflow(\\n' +
         '  { name: "telegram-hello" },\\n' +
         '  async (event, step) => {\\n' +
         '    return await step.do("capture-event", async () => {\\n' +
         '      return { receivedEventId: event.id };\\n' +
         '    });\\n' +
         '  },\\n' +
         ');\\n',
     );
     return { path };
   };
   \`\`\`

   Create scheduled routes with an explicit IANA time zone:

   \`\`\`js
   async () => await router.create({
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
       instanceIdTemplate: "daily-digest-\${event.id}",
     },
   });
   \`\`\`

   Create event-triggered routes with the \`router\` provider:

   \`\`\`js
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
         instanceIdTemplate: "telegram-hello-\${event}",
       },
     });
   };
   \`\`\`

   For \`send_workflow_event\`, omit \`workflowName\` because the fixed automation workflow host handles it, and set \`remoteWorkflowName\` to the saved \`defineWorkflow\` name that owns the target instance. Use \`{ kind: "instance_id", template }\` when the event can render the workflow instance id directly. Use \`{ kind: "stored_instance_id", keyTemplate }\` when a prior run stored the instance id under a rendered store key. **Complete when** every required artifact has been created or updated successfully.

5. Use the automation store only for small durable coordination values. Values are strings, structured values use \`JSON.stringify\`, and keys are stable and namespaced. Store inputs contain domain data only; trusted execution provenance is recorded by the kernel. Categories are ordinary labels. Use \`verification\` for JSON text that must satisfy a schema.

6. Re-read the completed route with \`router.get({ id })\` and \`state.readFile(workflowScriptPath)\` when saved. Run \`connections.verify({ id })\` for external providers. **Complete only when** the route trigger, action, workflow name, file path, and connection status all line up end to end.

Legacy \`router.cm.js\` files are outside this topology. Database-backed \`router.*\` rules are the routing source of truth; saved workflow files contain the behavior.`,
  }),
  ...starterSkill({
    name: "configuring-connections",
    title: "Configuring Connections",
    description:
      "Set up any Backoffice integration, connection, or named provider. Always use for setup requests such as ‘help me set up Reson8’, even when a provider-specific skill also applies; also use when credentials or a public origin are missing, or connection status must be verified.",
    body: `Treat connection setup as a handshake: **inspect → collect → configure → verify**.

## Required process

1. Read "/static/codemode/providers/connections.d.ts", then inspect the catalog and selected connection:

   \`\`\`js
   async () => {
     const connectionList = await connections.list({});
     const status = await connections.get({ id: "telegram" });
     const schema = await connections.schema({ id: "telegram" });
     const setup = await connections.setup({ id: "telegram" });
     return { connectionList, status, schema, setup };
   };
   \`\`\`

   Read the matching capability skill from the available skills, such as \`/static/skills/telegram-connection/SKILL.md\`, for provider-specific fields, webhook behavior, events, and tools. **Complete when** configurability, current status, required fields, masked existing values, and provider-specific setup steps are known.

2. Prefer a durable, generated setup form when required values remain missing. Read \`/static/skills/workflows/SKILL.md\` and \`/static/skills/generating-backoffice-uis/SKILL.md\`, then define an inline workflow whose completed \`step.do\` returns a \`$ui\` form and whose following \`step.waitForEvent\` collects the submission. Build controls only for missing fields, label them from the live schema and provider skill, bind them under one response object, and submit that object with one \`WorkflowEventButton\`. Continue configuration and verification inside durable \`step.do\` calls so the user can finish the handshake through the rendered interface. When every required value was already supplied in the request, proceed directly without an input workflow.

   Collect secrets, sender identities, account ids, bucket details, and public webhook origins exactly as supplied. Use submitted values only as the configuration payload; keep secrets out of labels, summaries, final output, and follow-up prose. **Complete when** a waiting workflow displays controls for every missing required field, or every required field already has a user-supplied or configured value.

3. Configure with a payload that matches the live schema, inside the setup workflow when step 2 created one. Supply \`origin\` only when setup instructions require a public Backoffice origin:

   \`\`\`js
   async () => {
     return await connections.configure({
       id: "telegram",
       payload: {
         botToken: "...",
         webhookSecretToken: "...",
         webhookBaseUrl: "https://public.example.com",
       },
     });
   };
   \`\`\`

   When schema/setup exposes no configurable fields or identifies a managed connection, follow its manual steps and status \`nextSteps\` instead of calling \`configure\`. **Complete when** the configure call succeeds or the managed setup path is explicit.

4. Verify and re-read status in the same setup workflow when one is active. \`connections.verify\` always returns a required \`verification\` result; treat \`verification.ok\` as the single authoritative verification signal. Return a generated final UI that presents the connection status, verification result, and actionable next steps while preserving the raw results as ordinary sibling fields:

   \`\`\`js
   async () => {
     const result = await connections.verify({ id: "telegram" });
     const finalStatus = await connections.get({ id: "telegram" });
     return {
       result,
       finalStatus,
       verified: result.verification.ok,
       verificationMessage: result.verification.message,
     };
   };
   \`\`\`

   **Complete only when** \`result.verification.ok\` is true and the rendered final result confirms the configured connection. If it is false, present \`result.verification.message\`, \`missing\` fields, and \`nextSteps\` in the generated UI; start another input handshake only when those next steps require another user-supplied value.

Use \`connections.reset({ id, confirm: id })\` only for an explicit reset request, then re-read status so the cleared state is visible.`,
  }),
  ...starterSkill({
    name: "workflows",
    title: "Workflows",
    description:
      "Orchestrate durable multi-step work with defineWorkflow and operate workflow instances. Use when a current task needs retries, sleeps, waiting for an external event, or the user asks to inspect, signal, or retry a workflow instance.",
    body: `Use \`defineWorkflow\` for work that must survive retries, time, or an external continuation.

## Authoring a workflow

1. **Preflight.** Apply the system guidance's closed-world preflight before calling \`defineWorkflow\`. The workflow authoring declarations are already present in the system reference; read the provider declarations selected by that gate.

   **Complete when** the closed-world preflight passes. When it cannot pass, complete this branch by reporting the blocking requirement.

2. **Author.** Define the workflow directly at the top level. Inline definitions automatically start; retain the returned \`workflowName\` and \`instanceId\`. Save a workflow file only when the user asks for persistent automation behavior; use the Building Automations skill for that branch.

   \`\`\`js
   defineWorkflow(
     { name: "approval-workflow" },
     async (_event, step) => {
       const request = await step.do("prepare-request", async () => {
         return { requestId: crypto.randomUUID() };
       });

       const approval = await step.waitForEvent("approval", {
         type: "approval",
         timeout: "15 minutes",
       });

       return { request, approval: approval.payload };
     },
   );
   \`\`\`

   Put side effects, provider calls, and expensive work inside \`step.do\`. Keep pure deterministic calculations outside steps. Use stable, descriptive step names because history and retries address those names. Use \`step.sleep\` or \`step.sleepUntil\` for time and \`step.waitForEvent\` for external continuation.

   **Complete when** every non-deterministic operation has a durable step and every continuation has an exact event type.

3. **Observe.** Read the returned instance with \`workflow.getInstance\`. Inspect output for a completed run, confirm the authored event type for a waiting run, and read \`workflow.getHistory\` when diagnosing an errored run. If instance details are temporarily unavailable, call \`workflow.listInstances\` once as a status fallback and report the backend failure beside the observed summary.

   **Complete when** the instance is \`complete\` with observed output, intentionally \`waiting\` with its exact continuation, or \`errored\` with the failed step and error identified.

## Operating an existing workflow

Read "/static/codemode/providers/workflow.d.ts" for exact inputs:

- \`workflow.listWorkflows({})\` discovers registered workflow names.
- \`workflow.createInstance({ workflowName, remoteWorkflowName, instanceId, params })\` starts a registered or saved workflow; inline \`defineWorkflow\` runs do not need this call.
- \`workflow.listInstances({ workflowName, status, pageSize, cursor })\` lists instances.
- \`workflow.getInstance({ workflowName, instanceId })\` reads status, output, and error.
- \`workflow.getHistory({ workflowName, instanceId })\` exposes steps, events, and emissions for diagnosis.
- \`workflow.sendEvent({ workflowName, instanceId, type, payload })\` resumes a waiting instance.
- \`workflow.retryInstance({ workflowName, instanceId, stepKey, delayMs, reason })\` retries failed work.

For a waiting instance, send the exact event \`type\` expected by \`step.waitForEvent\`. For an errored instance, inspect the latest failed step before retrying and use its exact \`stepKey\`.`,
  }),
  ...starterSkill({
    name: "web",
    title: "Web Pages",
    description:
      "Retrieve web pages when the user mentions a page or URL, asks to fetch or read its contents, or wants HTML or Markdown extracted from it.",
    body: `Retrieve the page with the \`web\` provider.

1. Read "/static/codemode/providers/web.d.ts" and select the source: a \`url\` supplied by the user or provided \`html\`. **Complete when** the exact source and supported input fields are known.

2. Choose the output shape:
   - \`content\` for rendered HTML;
   - \`markdown\` for readable page text.

   **Complete when** one action matches how the result will be used.

3. Call \`web.extract\`:

   \`\`\`js
   async () => await web.extract({
     action: "markdown",
     input: { url: "https://example.com" },
   });
   \`\`\`

   Inspect the result branch selected by \`action\`. **Complete when** extraction succeeds and the returned content has been checked.`,
  }),
  ...starterSkill({
    name: "sandbox",
    title: "Sandbox",
    description:
      "Sandbox isolated shell work in Backoffice-managed Cloudflare containers. Use when the task requires starting, listing, executing commands in, or terminating a sandbox runtime.",
    body: `Treat a sandbox as a leased environment: **acquire → execute → release**. The \`sandbox\` provider is available only when the deployment exposes the Sandbox capability.

## Required process

1. Check for "/static/codemode/providers/sandbox.d.ts". If it is absent, report that this deployment does not expose the Sandbox capability. When present, read it and list current instances:

   \`\`\`js
   async () => await sandbox.listSandboxes({});
   \`\`\`

   Reuse a suitable running sandbox or choose a stable id for a new one. **Complete when** the target sandbox id and lifecycle disposition are known.

2. Start a sandbox with an idle lease. Set \`keepAlive\` only when the user asks to preserve it beyond the task:

   \`\`\`js
   async () => {
     return await sandbox.startSandbox({
       id: "dev",
       sleepAfter: "15m",
       startupCommand: "true",
       startupTimeoutMs: 30000,
     });
   };
   \`\`\`

   **Complete when** the requested sandbox exists and its returned status has been checked.

3. Execute bounded commands and inspect the discriminated result:

   \`\`\`js
   async () => {
     const result = await sandbox.executeCommand({
       sandboxId: "dev",
       command: "pwd && ls -la",
       timeoutMs: 30000,
     });
     if (!result.ok) {
       throw new Error(result.reason + ": " + result.message);
     }
     return result;
   };
   \`\`\`

   Trust command output only when \`result.ok\` is true. On failure, use \`reason\`, \`retryable\`, stdout, and stderr to decide whether to correct the command, restart the sandbox, or report the failure. **Complete when** every command succeeded and its expected output was checked, or a non-retryable failure was identified precisely.

4. Release the lease when the task no longer needs the environment:

   \`\`\`js
   async () => await sandbox.killSandbox({ sandboxId: "dev" });
   \`\`\`

   **Complete only when** the sandbox is killed, intentionally retained at the user's request, or left under an explicit \`sleepAfter\` lease.`,
  }),
};
