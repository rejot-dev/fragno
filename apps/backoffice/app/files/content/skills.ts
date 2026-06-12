import type { FileSystemArtifact } from "../types";

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
}): Record<string, FileSystemArtifact> => ({
  [`skills/${name}/SKILL.md`]: `---
name: ${name}
description: ${description}
---

# ${title}

${body}
`,
});

export const GENERAL_SKILL_CONTENT: Record<string, FileSystemArtifact> = {
  ...starterSkill({
    name: "building-automations",
    title: "Building Automations",
    description:
      "Build Backoffice automations in codemode. Use when creating event router behavior, wiring useful configured connections together, reading the event catalog, updating /starter/automations/scripts/router.cm.js, or adding durable workflow scripts.",
    body: `Use this skill when the user wants the system to react to events from connections such as Telegram, Pi, OTP, or future integrations.

## Codemode-first workflow

1. Inspect available event shapes with the codemode events provider:

\`\`\`js
const catalog = await events.eventsCatalogList({});
const telegramMessage = await events.eventsCatalogGet({
  source: "telegram",
  type: "message.received",
});
\`\`\`

2. Read the current router at \`/starter/automations/scripts/router.cm.js\`. It is the default event entrypoint and already demonstrates routing Telegram, OTP, and Pi events.

\`\`\`js
const router = await state.readFile("/starter/automations/scripts/router.cm.js");
\`\`\`

3. Add small routing logic to the router. Filter early by \`event.source\` and \`event.eventType\`; do not perform long-running work in the router.

4. For long-running behavior, create a new \`*.workflow.js\` file under \`/starter/automations/scripts/\` and start it from the router with \`workflow.createInstance\`. Use \`state.writeFile\` when authoring from codemode.

5. If the automation depends on an external service, check whether the matching connection is configured. If not, use the Configuring Connections skill and work with the user to collect credentials or public URLs.

## Authoring pattern

\`\`\`js
await state.writeFile(
  "/starter/automations/scripts/my-new-workflow.workflow.js",
  'defineWorkflow(\n' +
    '  { name: "my-new-workflow" },\n' +
    '  async (event, step) => {\n' +
    '    return await step.do("finish", async () => ({ ok: true }));\n' +
    '  },\n' +
    ');\n',
);
\`\`\`

## Router pattern

\`\`\`js
async () => {
  const event = await state.readFile("/context/event.json").then(JSON.parse);

  if (event.source !== "telegram" || event.eventType !== "message.received") {
    return;
  }

  await workflow.createInstance({
    workflowName: "automation-codemode-script",
    remoteWorkflowName: "my-new-workflow",
    instanceId: "my-new-workflow-" + event.id,
    params: {
      automationEvent: event,
      workflowScriptPath: "/starter/automations/scripts/my-new-workflow.workflow.js",
    },
  });
};
\`\`\`

## Using the automation store

Use the \`store\` provider for small durable key/value coordination between automation runs and workflows. Store values are strings; use \`JSON.stringify\` for structured data.

\`\`\`js
const existing = await store.get({ key: "telegram/" + chatId });

await store.set({
  key: "telegram/" + chatId,
  value: userId,
  actor: event.actor,
  description: "Backoffice user linked to this Telegram chat.",
  category: ["telegram", "identity"],
});
\`\`\`

Available operations:

- \`store.get({ key })\`: returns an entry or \`null\`.
- \`store.set({ key, value, actor, description, category, verification })\`: creates or updates an entry. The \`actor\` field is required but may be \`null\` when no event actor is available.
- \`store.list({ prefix, limit })\`: lists entries whose keys start with \`prefix\`.
- \`store.delete({ key })\`: deletes an entry unless its category includes \`"system"\`.

Use stable, namespaced keys such as \`telegram/<chat-id>\`, \`telegram-pi-session/<user-id>\`, or \`pi/pi-default-agent\`. Add categories to make the Backoffice store overview easier to filter and understand. If \`category\` contains \`"system"\`, users cannot delete the entry from the overview or API, so only use it for entries that must be protected.

Use \`verification\` when storing JSON text that must match a schema. Verification is server-side only and is not persisted:

\`\`\`js
await store.set({
  key: "pi/default-agent-config",
  value: JSON.stringify({ harness: "default", model: "openai:gpt-5-mini" }),
  actor: event.actor,
  verification: [
    {
      type: "json-schema",
      schema: {
        type: "object",
        required: ["harness", "model"],
        properties: {
          harness: { type: "string" },
          model: { type: "string" },
        },
      },
    },
  ],
});
\`\`\`

## Useful connection setup examples

- Telegram message automation usually needs the Telegram Connection skill first.
- Email reply automation usually needs the Resend Connection skill first.
- LLM/agent automation usually needs the Pi Connection skill first.
- Identity linking usually uses OTP System plus the external connection's actor id.
`,
  }),
  ...starterSkill({
    name: "configuring-connections",
    title: "Configuring Connections",
    description:
      "Configure Backoffice connections with the user. Use when a connection is missing credentials, setup requires public URLs or secrets, or automations need Telegram, Resend, Reson8, Upload, Pi, GitHub, or Cloudflare status checked.",
    body: `Use this skill when an automation or user request depends on a Backoffice connection that may not be configured yet.

## Codemode-first process

1. Inspect connection status:

\`\`\`js
const connectionList = await connections.list({});
const telegram = await connections.get({ id: "telegram" });
const schema = await connections.schema({ id: "telegram" });
\`\`\`

2. Read the relevant connection skill in \`/starter/skills/<connection-or-system>/SKILL.md\` for capability-specific fields and gotchas.

3. Work with the user to obtain required information. Do not invent secrets, API keys, sender addresses, webhook origins, public tunnel URLs, bucket configuration, or model provider keys.

4. Configure only after the user has supplied the required values:

\`\`\`js
await connections.configure({
  id: "telegram",
  payload: {
    botToken: "...",
    webhookSecretToken: "...",
    webhookBaseUrl: "https://public.example.com",
  },
});
\`\`\`

5. Verify after configuration:

\`\`\`js
const status = await connections.verify({ id: "telegram" });
\`\`\`

## User collaboration checklist

- Explain why the connection is needed for the requested automation.
- Ask for only the fields the schema/status says are missing.
- Mark secrets clearly and avoid echoing them back unnecessarily.
- For webhook integrations, confirm the public Backoffice origin or tunnel URL.
- After configuring, summarize configured status and next steps.
`,
  }),
  ...starterSkill({
    name: "workflows",
    title: "Workflows",
    description:
      "Build and operate durable Backoffice workflows in codemode. Use when creating *.workflow.js files, using defineWorkflow, step.do, step.sleep, step.waitForEvent, retries, or workflow.* runtime tools.",
    body: `Use this skill for durable, replayable automation work that should survive waits, sleeps, retries, or external events.

Backoffice workflow scripts live in \`/starter/automations/scripts/*.workflow.js\`. They are not run directly; router scripts start them through \`workflow.createInstance\`.

## Coding workflow scripts

Define a workflow with \`defineWorkflow\`:

\`\`\`js
defineWorkflow(
  { name: "approval-workflow" },
  async (event, step) => {
    const input = event.payload;

    const result = await step.do("perform durable work", async () => {
      return { ok: true, requestId: input.requestId };
    });

    await step.sleep("cooldown", "2 seconds");

    const approval = await step.waitForEvent("approval", {
      type: "approval",
      timeout: "15 minutes",
    });

    return { result, approval: approval.payload };
  },
);
\`\`\`

Use \`step.do\` around side effects and expensive calls. Use stable step names because history, retries, and debugging refer to them. Use \`step.sleep\` for timers and \`step.waitForEvent\` for external continuation.

## Starting workflows from codemode

\`\`\`js
await workflow.createInstance({
  workflowName: "automation-codemode-script",
  remoteWorkflowName: "approval-workflow",
  instanceId: "approval-" + event.id,
  params: {
    automationEvent: event,
    workflowScriptPath: "/starter/automations/scripts/approval.workflow.js",
  },
});
\`\`\`

## Operating workflows with codemode tools

The \`workflow\` provider can:

- \`listWorkflows({})\`: list registered workflow names;
- \`createInstance({ workflowName, remoteWorkflowName, instanceId, params })\`: start a workflow;
- \`listInstances({ workflowName, status, pageSize, cursor })\`: inspect instances;
- \`getInstance({ workflowName, instanceId })\`: inspect one instance;
- \`getHistory({ workflowName, instanceId })\`: debug steps, events, and emissions;
- \`sendEvent({ workflowName, instanceId, type, payload })\`: resume a waiting workflow;
- \`retryInstance({ workflowName, instanceId, stepKey, delayMs, reason })\`: retry failed work.

## Debugging

If an instance is stuck waiting, confirm the sent event \`type\` exactly matches the workflow's \`step.waitForEvent\` type. If retries or timeouts repeat, inspect history and the latest step error.
`,
  }),
  ...starterSkill({
    name: "sandbox",
    title: "Sandbox",
    description:
      "Work with Cloudflare sandboxes from Backoffice codemode. Use when starting, listing, killing, or executing commands in sandboxes with sandbox.startSandbox, sandbox.listSandboxes, sandbox.killSandbox, or sandbox.executeCommand.",
    body: `Use this skill when the task needs an isolated Cloudflare sandbox to run shell commands or inspect a runtime environment. Sandbox tools are runtime tools and are not tied to a single Backoffice capability skill.

## Codemode provider

Use the \`sandbox\` provider:

\`\`\`js
const started = await sandbox.startSandbox({
  id: "dev",
  sleepAfter: "15m",
  startupCommand: "true",
});

const sandboxes = await sandbox.listSandboxes({});

const result = await sandbox.executeCommand({
  sandboxId: "dev",
  command: "pwd && ls -la",
  timeoutMs: 30000,
});

if (!result.ok) {
  throw new Error(result.message);
}

await sandbox.killSandbox({ sandboxId: "dev" });
\`\`\`

## Guidance

- Use stable sandbox ids for repeatable work.
- Prefer \`sleepAfter\` instead of leaving sandboxes alive forever.
- Check \`result.ok\` before trusting stdout/stderr.
- Use \`timeoutMs\` for commands that might hang.
- Kill sandboxes when the user no longer needs them.
`,
  }),
};
