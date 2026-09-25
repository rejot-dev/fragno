import type { FileContent } from "../interface";

export const SYSTEM_AUTOMATION_SCRIPT_PATHS = {
  workspaceFileInitialization: "automations/workspace-file-initialization.workflow.js",
} as const;

export const SYSTEM_AUTOMATION_CONTENT: Record<string, FileContent> = {
  "automations/workspace-file-initialization.workflow.js": `defineWorkflow(
  { name: "workspace-file-initialization" },
  async (event, step) => {
    const automationEvent = event;

    const orgId = automationEvent.subject?.orgId;
    if (!orgId) {
      throw new Error("organization.created event is missing subject.orgId.");
    }
    const org = context.org(orgId);

    const seeded = await step.do("seed workspace starter files", async () => {
      return await org.internal.filesSeedExecute({});
    });

    const automationRoutes = await step.do("seed starter automation routes", async () => {
      return await org.internal.automationsRoutesSeedStarter({});
    });

    return { seeded, automationRoutes };
  },
);
`,
};
