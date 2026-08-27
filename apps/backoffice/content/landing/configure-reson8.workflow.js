defineWorkflow({ name: "configure-reson8" }, async (_event, step) => {
  await step.do("request Reson8 API key", async () => ({
    $ui: {
      version: 1,
      state: { response: { apiKey: "" } },
      spec: {
        root: "form",
        elements: {
          form: {
            type: "Stack",
            props: { gap: "md" },
            children: ["heading", "description", "apiKey", "submit"],
          },
          heading: {
            type: "Heading",
            props: { text: "Set up Reson8", level: 2 },
            children: [],
          },
          description: {
            type: "Text",
            props: {
              text: "Enter your Reson8 API key to enable speech-to-text for this organisation.",
              tone: "muted",
            },
            children: [],
          },
          apiKey: {
            type: "TextInput",
            props: {
              label: "Reson8 API key",
              value: { $bindState: "/response/apiKey" },
              description: "Your key is handled as a secret and is not shown in the setup result.",
              required: true,
              secret: true,
            },
            children: [],
          },
          submit: {
            type: "WorkflowEventButton",
            props: {
              label: "Configure Reson8",
              eventType: "reson8-credentials",
              payload: { $state: "/response" },
              variant: "primary",
            },
            children: [],
          },
        },
      },
    },
  }));

  const submitted = await step.waitForEvent("reson8-credentials", {
    type: "reson8-credentials",
  });
  const submittedPayload = /** @type {{apiKey?: unknown}} */ (submitted.payload);
  const apiKey = String(submittedPayload.apiKey ?? "").trim();
  if (!apiKey) {
    throw new Error("A Reson8 API key is required.");
  }

  const configured = await step.do("configure Reson8", async () => {
    return await connections.configure({ id: "reson8", payload: { apiKey } });
  });
  const verification = await step.do("verify Reson8", async () => {
    const result = await connections.verify({ id: "reson8" });
    const finalStatus = await connections.get({ id: "reson8" });
    return { result, finalStatus };
  });

  return { configured, ...verification };
});
