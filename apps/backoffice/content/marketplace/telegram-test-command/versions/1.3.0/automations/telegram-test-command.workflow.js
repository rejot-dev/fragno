defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
  const automationEvent = /** @type {WorkflowEvent<{text?: string; chatId: string}>} */ (event);
  const text = automationEvent.payload.text;
  const chatId = automationEvent.payload.chatId;

  if (text !== "/test") {
    return { skipped: true, reason: "not-test-command" };
  }

  await step.sleep("wait 3 seconds", "3 seconds");

  const configuredMessage = await step.do("load configured test reply", async () => {
    const storedMessage = await store.get({
      key: "marketplace/telegram-test-command/message",
    });
    return storedMessage?.value ?? "Telegram integration verified after a 3 second delay.";
  });

  await step.do("send delayed test reply", async () => {
    await telegram.sendMessage({
      chatId,
      text: configuredMessage,
      parseMode: "Markdown",
    });
  });

  return { sent: true };
});
