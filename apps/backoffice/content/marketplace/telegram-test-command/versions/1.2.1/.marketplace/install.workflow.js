/// <reference path="/static/codemode/workflow-authoring.d.ts" />

defineWorkflow(
  { name: "install-telegram-test-command" },
  async (/** @type {WorkflowEvent<any>} */ event, step) => {
    const workflowScriptPath =
      event.payload.installedFiles["automations/telegram-test-command.workflow.js"];
    if (!workflowScriptPath) {
      throw new Error("Telegram test command workflow was not installed.");
    }

    await step.do("ensure Telegram /test route", async () => {
      const desired = {
        id: "telegram-test-command",
        name: "Telegram /test command",
        trigger: {
          kind: "event",
          source: "telegram",
          eventType: "message.received",
          matcher: { path: "$.payload.text", op: "eq", value: "/test" },
        },
        priority: 110,
        action: {
          kind: "start_workflow",
          authority: { kind: "organization-automation" },
          workflowScriptPath,
          instanceIdTemplate: "telegram-test-${event.id}",
        },
        managedBy: {
          kind: "marketplace",
          listingId: event.payload.listingId,
          resourceKey: "telegram-test-command-route",
          version: event.payload.version,
        },
      };
      // @ts-expect-error -- router is injected into the workflow runtime.
      const existing = await router.get({ id: desired.id });
      if (!existing) {
        // @ts-expect-error -- router is injected into the workflow runtime.
        return await router.create({ ...desired, enabled: true });
      }

      const managedBy = existing.metadata?.managedBy;
      const ownedByThisInstallation =
        managedBy?.kind === "marketplace" &&
        managedBy.listingId === event.payload.listingId &&
        managedBy.resourceKey === desired.managedBy.resourceKey;
      if (!ownedByThisInstallation) {
        throw new Error(
          "Automation route 'telegram-test-command' already exists and is not managed by this Marketplace installation.",
        );
      }

      // @ts-expect-error -- router is injected into the workflow runtime.
      return await router.update({
        ...desired,
        enabled: existing.enabled,
      });
    });
  },
);
