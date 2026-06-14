import type { FileSystemArtifact } from "../types";

export const SYSTEM_AUTOMATION_SCRIPT_PATHS = {
  systemRouter: "automations/router.cm.js",
  workspaceFileInitialization: "automations/workspace-file-initialization.workflow.js",
  codemodeTypesRefresh: "automations/codemode-types-refresh.workflow.js",
} as const;

export const SYSTEM_AUTOMATION_CONTENT: Record<string, FileSystemArtifact> = {
  "automations/router.cm.js": `async () => {
  const event = await state.readFile("/context/event.json").then(JSON.parse);

  const instanceIdForEvent = (prefix) => {
    return prefix + "-" + event.id.replace(/[^a-zA-Z0-9-_]/g, "-");
  };

  if (event.source === "auth" && event.eventType === "organization.created") {
    await workflow.createInstance({
      workflowName: "automation-codemode-script",
      remoteWorkflowName: "workspace-file-initialization",
      instanceId: instanceIdForEvent("workspace-file-initialization"),
      params: {
        automationEvent: event,
        workflowScriptPath: "/system/automations/workspace-file-initialization.workflow.js",
      },
    });
  }

  if (event.eventType === "capability.configured") {
    await workflow.createInstance({
      workflowName: "automation-codemode-script",
      remoteWorkflowName: "codemode-types-refresh",
      instanceId: instanceIdForEvent("codemode-types-refresh"),
      params: {
        automationEvent: event,
        workflowScriptPath: "/system/automations/codemode-types-refresh.workflow.js",
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

    const codemodeTypes = await step.do("write codemode dts", async () => {
      const rendered = await internal.codemodeTypesRender({});
      await state.writeFile(rendered.path, rendered.content);
      return {
        path: rendered.path,
        configuredCapabilities: rendered.configuredCapabilities,
      };
    });

    return { ...configured, seeded, codemodeTypes };
  },
);
`,
  "automations/codemode-types-refresh.workflow.js": `defineWorkflow(
  { name: "codemode-types-refresh" },
  async (_event, step) => {
    const rendered = await step.do("render codemode dts", async () => {
      return await internal.codemodeTypesRender({});
    });

    const existing = await step.do("read existing codemode dts", async () => {
      return (await state.exists(rendered.path))
        ? await state.readFile(rendered.path)
        : null;
    });

    if (existing === rendered.content) {
      return {
        changed: false,
        path: rendered.path,
        configuredCapabilities: rendered.configuredCapabilities,
      };
    }

    await step.do("write codemode dts", async () => {
      await state.writeFile(rendered.path, rendered.content);
    });

    return {
      changed: true,
      path: rendered.path,
      configuredCapabilities: rendered.configuredCapabilities,
    };
  },
);
`,
};
