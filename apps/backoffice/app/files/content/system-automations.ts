import type { FileSystemArtifact } from "../types";

export const AUTOMATION_SCRIPT_PATHS = {
  systemRouter: "automations/router.cm.js",
  workspaceRouter: "automations/router.cm.js",
  workspaceFileInitialization: "automations/workspace-file-initialization.workflow.js",
  telegramUserLinking: "automations/telegram-user-linking.workflow.js",
  telegramUserPiLinking: "automations/telegram-user-pi-linking.workflow.js",
  telegramTestCommand: "automations/telegram-test-command.workflow.js",
} as const;

export const SYSTEM_AUTOMATION_CONTENT: Record<string, FileSystemArtifact> = {
  "automations/router.cm.js": `async () => {
  const event = await state.readFile("/context/event.json").then(JSON.parse);

  if (event.source === "auth" && event.eventType === "organization.created") {
    const instanceId = "workspace-file-initialization-" + event.id.replace(/[^a-zA-Z0-9-_]/g, "-");
    await workflow.createInstance({
      workflowName: "automation-codemode-script",
      remoteWorkflowName: "workspace-file-initialization",
      instanceId,
      params: {
        automationEvent: event,
        workflowScriptPath: "/system/automations/workspace-file-initialization.workflow.js",
      },
    });
  }
};
`,
  "automations/workspace-file-initialization.workflow.js": `defineWorkflow(
  { name: "workspace-file-initialization" },
  async (event, step) => {
    const automationEvent = event.payload.automationEvent;

    if (
      automationEvent.source !== "auth" ||
      automationEvent.eventType !== "organization.created"
    ) {
      return { skipped: true, reason: "not-organization-created" };
    }

    const configured = await step.do("configure upload database connection", async () => {
      await connections.configure({
        id: "upload",
        payload: { provider: "database" },
      });

      return { configured: true, id: "upload", provider: "database" };
    });

    const seeded = await step.do("seed workspace starter files", async () => {
      return await internal.filesSeedExecute({});
    });

    return { ...configured, seeded };
  },
);
`,
};
