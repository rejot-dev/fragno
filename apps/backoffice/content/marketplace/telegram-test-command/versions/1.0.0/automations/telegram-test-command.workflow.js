defineWorkflow({ name: "telegram-test-command" }, async (event, step) => {
  const automationEvent = event.payload.automationEvent;
  const text = automationEvent.payload.text;
  const chatId = automationEvent.payload.chatId;

  if (text !== "/test") {
    return { skipped: true, reason: "not-test-command" };
  }

  await step.sleep("wait 3 seconds", "3 seconds");

  await step.do("send delayed test reply", async () => {
    await telegram.sendMessage({
      chatId,
      text: "Delayed /test reply after 3 seconds.",
      parseMode: "Markdown",
    });
  });

  return { sent: true };
});
