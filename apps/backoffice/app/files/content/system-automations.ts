import type { FileSystemArtifact } from "../types";

export const SYSTEM_AUTOMATION_SCRIPT_PATHS = {
  workspaceFileInitialization: "automations/workspace-file-initialization.workflow.js",
} as const;

export const SYSTEM_AUTOMATION_CONTENT: Record<string, FileSystemArtifact> = {
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

    const orgId = automationEvent.subject?.orgId;
    if (!orgId) {
      throw new Error("organization.created event is missing subject.orgId.");
    }
    const org = context.org(orgId);

    const configured = await step.do("configure upload database connection", async () => {
      await org.connections.configure({
        id: "upload",
        payload: { provider: "database" },
      });

      return { configured: true, id: "upload", provider: "database" };
    });

    const seeded = await step.do("seed workspace starter files", async () => {
      return await org.internal.filesSeedExecute({});
    });

    const automationRoutes = await step.do("seed starter automation routes", async () => {
      return await org.internal.automationsRoutesSeedStarter({});
    });

    return { ...configured, seeded, automationRoutes };
  },
);
`,
};
