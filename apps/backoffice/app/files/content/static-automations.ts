import type { FileContent } from "../interface";

export const STATIC_AUTOMATION_SCRIPT_PATHS = {
  projectFilesConfigure: "automations/project-files-configure.workflow.js",
} as const;

export const STATIC_AUTOMATION_CONTENT: Record<string, FileContent> = {
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
};
