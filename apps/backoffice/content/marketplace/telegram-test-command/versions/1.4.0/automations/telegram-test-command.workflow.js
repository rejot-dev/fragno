defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
  const automationEvent = /** @type {WorkflowEvent<{chatId: string}>} */ (event);
  const chatId = automationEvent.payload.chatId;

  await step.sleep("wait 3 seconds", "3 seconds");

  const configuredMessage = await step.do("load configured test reply", async () => {
    const storedMessage = await store.get({
      key: "marketplace/telegram-test-command/message",
    });
    return storedMessage?.value ?? "Telegram integration verified after a 3 second delay.";
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
