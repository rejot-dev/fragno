/// <reference path="/static/codemode/workflow-authoring.d.ts" />

const DEFAULT_MESSAGE = "Telegram integration verified after a 3 second delay.";

// Whatever this workflow returns becomes the installation's settings. Installing the same version
// again runs it again, offering the current reply, which is how the reply is changed.
export default defineWorkflow(
  { name: "install-telegram-test-command" },
  async (/** @type {WorkflowEvent<any>} */ event, step) => {
    const currentMessage = await step.do("load current test message", async () => {
      const installation = await packages.get({ listingId: event.payload.listingId });
      const message = installation?.settings.message;
      return typeof message === "string" ? message : DEFAULT_MESSAGE;
    });

    await step.do("request test message", async () => ({
      $ui: {
        version: 1,
        state: { response: { message: currentMessage } },
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
                description:
                  "Saved with this installation. Install the package again to change it.",
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
    const message = /** @type {{message?: unknown}} */ (configuration.payload).message;
    if (typeof message !== "string" || !message.trim()) {
      throw new Error("Telegram test message must be a non-empty string.");
    }
    return { message: message.trim() };
  },
);
