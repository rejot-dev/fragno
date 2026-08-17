/// <reference path="/static/codemode/workflow-authoring.d.ts" />

defineWorkflow(
  { name: "install-telegram-test-command" },
  async (/** @type {WorkflowEvent<any>} */ event, step) => {
    const workflowScriptPath =
      event.payload.installedFiles["automations/telegram-test-command.workflow.js"];
    if (!workflowScriptPath) {
      throw new Error("Telegram test command workflow was not installed.");
    }

    const existingMessage = await step.do("load current test message", async () => {
      // @ts-expect-error -- store is injected into the workflow runtime.
      const storedMessage = await store.get({
        key: "marketplace/telegram-test-command/message",
      });
      return storedMessage?.value ?? "Telegram integration verified after a 3 second delay.";
    });

    await step.do("request test message", async () => ({
      $ui: {
        version: 1,
        state: { response: { message: existingMessage } },
        spec: {
          root: "form",
          elements: {
            form: {
              type: "Stack",
              props: { gap: "md" },
              children: ["heading", "description", "message", "submit"],
            },
            heading: {
              type: "Heading",
              props: { text: "Configure the Telegram test reply", level: 3 },
              children: [],
            },
            description: {
              type: "Text",
              props: {
                text: "Choose the message that Telegram should send after receiving /test.",
                tone: "muted",
              },
              children: [],
            },
            message: {
              type: "TextArea",
              props: {
                label: "Test message",
                value: { $bindState: "/response/message" },
                description: "This message is stored in the selected automation scope.",
                required: true,
                rows: 4,
              },
              children: [],
            },
            submit: {
              type: "WorkflowEventButton",
              props: {
                label: "Save test message",
                eventType: "telegram-test-command.message-configured",
                payload: { $state: "/response" },
                variant: "primary",
              },
              children: [],
            },
          },
        },
      },
    }));

    const configuration = await step.waitForEvent("wait for test message", {
      type: "telegram-test-command.message-configured",
    });
    const configuredMessage = /** @type {{message?: unknown}} */ (configuration.payload).message;
    if (typeof configuredMessage !== "string" || !configuredMessage.trim()) {
      throw new Error("Telegram test message must be a non-empty string.");
    }

    await step.do("store test message", async () => {
      // @ts-expect-error -- store is injected into the workflow runtime.
      return await store.set({
        key: "marketplace/telegram-test-command/message",
        value: configuredMessage.trim(),
        description: "Reply sent by the Marketplace-managed Telegram /test command.",
        category: ["marketplace", "telegram", "configuration"],
      });
    });

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
