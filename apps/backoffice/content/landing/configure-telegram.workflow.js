defineWorkflow({ name: "configure-telegram" }, async (_event, step) => {
  await step.do("request Telegram bot token", async () => ({
    $ui: {
      version: 1,
      state: { response: { botToken: "" } },
      spec: {
        root: "form",
        elements: {
          form: {
            type: "Stack",
            props: { gap: "md" },
            children: ["heading", "description", "botToken", "submit"],
          },
          heading: {
            type: "Heading",
            props: { text: "Set up Telegram", level: 2 },
            children: [],
          },
          description: {
            type: "Text",
            props: {
              text: "Enter your Telegram bot token so automations can message your team.",
              tone: "muted",
            },
            children: [],
          },
          botToken: {
            type: "TextInput",
            props: {
              label: "Telegram bot token",
              value: { $bindState: "/response/botToken" },
              description:
                "Your token is handled as a secret and is not shown in the setup result.",
              required: true,
              secret: true,
            },
            children: [],
          },
          submit: {
            type: "WorkflowEventButton",
            props: {
              label: "Configure Telegram",
              eventType: "telegram-credentials",
              payload: { $state: "/response" },
              variant: "primary",
            },
            children: [],
          },
        },
      },
    },
  }));

  const submitted = await step.waitForEvent("telegram-credentials", {
    type: "telegram-credentials",
  });
  const submittedPayload = /** @type {{botToken?: unknown}} */ (submitted.payload);
  const botToken = String(submittedPayload.botToken ?? "").trim();
  if (!botToken) {
    throw new Error("A Telegram bot token is required.");
  }

  const connectionId = "backoffice#telegram";
  const configured = await step.do("configure Telegram", async () => {
    return await integrations.setup({
      kind: "input",
      connectionId,
      input: { botToken, botUsername: null },
    });
  });
  const verified = await step.do("verify Telegram", async () => {
    return await integrations.verify({ connectionId });
  });

  return { configured, verified };
});
