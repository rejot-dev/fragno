defineWorkflow({ name: "install-telegram-test-command" }, async (event, step) => {
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
        remoteWorkflowName: "telegram-test-command",
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
    const existing = await router.get({ id: desired.id });
    if (!existing) {
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

    return await router.update({
      ...desired,
      enabled: existing.enabled,
    });
  });
});
