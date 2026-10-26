export const SYSTEM_AUTOMATION_SCRIPT_PATHS = {
  workspaceFileInitialization: "automations/workspace-file-initialization.workflow.js",
} as const;

export const SYSTEM_AUTOMATION_CONTENT: Record<string, string | Uint8Array> = {
  "automations/workspace-file-initialization.workflow.js": `export default defineWorkflow(
  { name: "workspace-file-initialization" },
  async (event, step) => {
    const automationEvent = event;

    const organization = automationEvent.subject?.scope;
    if (organization?.kind !== "org") {
      throw new Error("organization.created event does not name its organization's scope.");
    }
    const org = context.org(organization.orgId);

    const seeded = await step.do("seed workspace starter files", async () => {
      return await org.internal.filesSeedExecute({});
    });

    return { seeded };
  },
);
`,
};
