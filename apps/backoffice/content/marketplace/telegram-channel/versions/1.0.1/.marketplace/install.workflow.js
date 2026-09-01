/// <reference path="/static/codemode/workflow-authoring.d.ts" />

defineWorkflow(
  { name: "install-telegram-channel" },
  async (/** @type {WorkflowEvent<any>} */ event, step) => {
    const userLinkingWorkflowScriptPath =
      event.payload.installedFiles["automations/telegram-user-linking.workflow.js"];
    const piLinkingWorkflowScriptPath =
      event.payload.installedFiles["automations/telegram-user-pi-linking.workflow.js"];
    if (!userLinkingWorkflowScriptPath || !piLinkingWorkflowScriptPath) {
      throw new Error("Telegram Channel workflows were not installed.");
    }

    const routes = [
      {
        id: "telegram-start-linking",
        name: "Telegram /start identity linking",
        trigger: {
          kind: "event",
          source: "telegram",
          eventType: "message.received",
          matcher: { path: "$.payload.text", op: "eq", value: "/start" },
        },
        priority: 100,
        action: {
          kind: "start_workflow",
          authority: {
            kind: "organization-automation",
            grants: [
              { namespace: "identity", permission: "resolve" },
              { namespace: "otp", permission: "create" },
              { namespace: "store", permission: "modify" },
              { namespace: "telegram", permission: "send" },
            ],
          },
          workflowScriptPath: userLinkingWorkflowScriptPath,
          instanceIdTemplate: "telegram-link-${event.id}",
        },
        managedBy: {
          kind: "marketplace",
          listingId: event.payload.listingId,
          resourceKey: "telegram-start-linking-route",
          version: event.payload.version,
        },
      },
      {
        id: "telegram-identity-claim-completed",
        name: "Forward Telegram identity claim completion",
        trigger: {
          kind: "event",
          source: "otp",
          eventType: "identity.claim.completed",
          matcher: {
            actor: {
              participation: "initiator",
              scope: "external",
              source: "telegram",
            },
          },
        },
        priority: 90,
        action: {
          kind: "send_workflow_event",
          target: {
            kind: "stored_instance_id",
            keyTemplate: "telegram/claim-workflow/${event.payload.otpId}",
          },
          eventType: "identity-claim-completed",
          payload: "$event",
        },
        managedBy: {
          kind: "marketplace",
          listingId: event.payload.listingId,
          resourceKey: "telegram-identity-claim-completed-route",
          version: event.payload.version,
        },
      },
      {
        id: "telegram-pi-linking",
        name: "Telegram Pi session linking",
        trigger: {
          kind: "event",
          source: "telegram",
          eventType: "message.received",
          matcher: {
            any: [
              { path: "$.payload.text", op: "eq", value: "/pi" },
              {
                all: [
                  { path: "$.payload.text", op: "exists" },
                  {
                    not: {
                      path: "$.payload.text",
                      op: "startsWith",
                      value: "/",
                    },
                  },
                ],
              },
            ],
          },
        },
        priority: 120,
        action: {
          kind: "start_workflow",
          authority: {
            kind: "linked-user",
            grants: "inherit",
          },
          workflowScriptPath: piLinkingWorkflowScriptPath,
          instanceIdTemplate: "telegram-pi-${event.id}",
        },
        managedBy: {
          kind: "marketplace",
          listingId: event.payload.listingId,
          resourceKey: "telegram-pi-linking-route",
          version: event.payload.version,
        },
      },
    ];

    for (const desired of routes) {
      await step.do(`ensure ${desired.id} route`, async () => {
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
            `Automation route '${desired.id}' already exists and is not managed by this Marketplace installation.`,
          );
        }

        // Omit enabled so PATCH preserves the latest user-controlled operational state.
        const updated = await router.update(desired);
        if (!updated) {
          throw new Error(`Automation route '${desired.id}' disappeared during installation.`);
        }
        return updated;
      });
    }
  },
);
