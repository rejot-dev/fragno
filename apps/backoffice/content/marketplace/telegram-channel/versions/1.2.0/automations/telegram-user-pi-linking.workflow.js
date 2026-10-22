export default defineWorkflow({ name: "telegram-user-pi-linking" }, async (event, step) => {
  // Defined by this package's install workflow.
  const TELEGRAM_AGENT = "telegram";
  const automationEvent = /** @type {WorkflowEvent<{text?: string; chatId: string}>} */ (event);

  const text = automationEvent.payload.text ?? "";
  const chatId = automationEvent.payload.chatId;
  const workflowInstanceId = event.instanceId;

  const telegramActor = automationEvent.actors.initiator;
  if (
    telegramActor.scope !== "external" ||
    telegramActor.source !== "telegram" ||
    telegramActor.type !== "chat" ||
    telegramActor.id !== chatId
  ) {
    return { skipped: true, reason: "invalid-telegram-actor" };
  }

  const linkedUserActor = automationEvent.actors.principal;
  if (linkedUserActor?.scope !== "internal" || linkedUserActor.type !== "user") {
    throw new Error("Telegram Pi workflow requires a linked user principal.");
  }

  const commandReply = await step.do("reply to pi command if needed", async () => {
    if (text !== "/pi") {
      return { sent: false };
    }

    await integrations.execute({
      connectionId: "backoffice#telegram",
      actionId: "messages.send",
      input: {
        chatId,
        text: "Messages in this chat go to the Telegram agent.",
        parseMode: "Markdown",
        disableWebPagePreview: false,
        replyToMessageId: null,
      },
    });
    return { sent: true };
  });

  if (commandReply.sent || !text) {
    return { agentName: TELEGRAM_AGENT };
  }

  await step.do("send telegram typing action", async () => {
    await integrations.execute({
      connectionId: "backoffice#telegram",
      actionId: "chat-actions.send",
      input: { chatId, action: "typing" },
    });
  });

  const assistantText = await step.do("run pi turn", async () => {
    // Every linked chat in this scope shares the agent's conversation, so name the chat.
    const resp = await pi.runPrompt({
      agentName: TELEGRAM_AGENT,
      requestId: workflowInstanceId + ":run-pi-turn",
      content: "[Telegram chat " + chatId + "] " + text,
    });

    return resp.assistantText;
  });

  await step.do("send pi response if needed", async () => {
    if (!assistantText) {
      return { sent: false };
    }

    await integrations.execute({
      connectionId: "backoffice#telegram",
      actionId: "messages.send",
      input: {
        chatId,
        text: assistantText,
        parseMode: "Markdown",
        disableWebPagePreview: false,
        replyToMessageId: null,
      },
    });
    return { sent: true };
  });

  return { agentName: TELEGRAM_AGENT };
});
