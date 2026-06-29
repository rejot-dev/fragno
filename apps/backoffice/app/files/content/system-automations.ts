import type { FileSystemArtifact } from "../types";

export const SYSTEM_AUTOMATION_SCRIPT_PATHS = {
  workspaceFileInitialization: "automations/workspace-file-initialization.workflow.js",
  projectFilesConfigure: "automations/project-files-configure.workflow.js",
  codemodeTypesRefresh: "automations/codemode-types-refresh.workflow.js",
} as const;

export const SYSTEM_AUTOMATION_CONTENT: Record<string, FileSystemArtifact> = {
  "automations/codemode-types-refresh.workflow.js": `defineWorkflow(
  { name: "codemode-types-refresh" },
  async (_event, step) => {
    return await step.do("sync codemode dts", async () => {
      return await internal.codemodeTypesSync({});
    });
  },
);
`,
  "automations/project-files-configure.workflow.js": `defineWorkflow(
  { name: "project-files-configure" },
  async (event, step) => {
    const automationEvent = event.payload.automationEvent;

    if (
      automationEvent.source !== "automations" ||
      automationEvent.eventType !== "project.created"
    ) {
      return { skipped: true, reason: "not-project-created" };
    }

    const projectId = automationEvent.subject?.projectId ?? automationEvent.payload.project?.id;
    if (!projectId) {
      throw new Error("project.created event is missing subject.projectId.");
    }

    return await step.do("configure project database filesystem", async () => {
      return await internal.projectFilesConfigure({ projectId });
    });
  },
);
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

    const codemodeTypes = await step.do("write codemode dts", async () => {
      return await org.internal.codemodeTypesSync({});
    });

    return { ...configured, seeded, automationRoutes, codemodeTypes };
  },
);
`,
};
