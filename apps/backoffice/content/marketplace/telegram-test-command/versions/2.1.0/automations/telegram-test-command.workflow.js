const LISTING_ID = "system#telegram-test-command";
const DEFAULT_MESSAGE = "Telegram integration verified after a 3 second delay.";

export default defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
  const automationEvent = /** @type {WorkflowEvent<{chatId: string}>} */ (event);
  const chatId = automationEvent.payload.chatId;

  await step.sleep("wait 3 seconds", "3 seconds");

  const configuredMessage = await step.do("load configured test reply", async () => {
    const installation = await packages.get({ listingId: LISTING_ID });
    const message = installation?.settings.message;
    return typeof message === "string" ? message : DEFAULT_MESSAGE;
  });

  await step.do("send delayed test reply", async () => {
    await integrations.execute({
      connectionId: "backoffice#telegram",
      actionId: "messages.send",
      input: {
        chatId,
        text: configuredMessage,
        parseMode: "Markdown",
        disableWebPagePreview: false,
        replyToMessageId: null,
      },
    });
  });

  return { sent: true };
});
