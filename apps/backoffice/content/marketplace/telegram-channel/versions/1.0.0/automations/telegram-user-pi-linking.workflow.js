defineWorkflow({ name: "telegram-user-pi-linking" }, async (event, step) => {
  const automationEvent = /** @type {WorkflowEvent<{text?: string; chatId: string}>} */ (event);

  const text = automationEvent.payload.text ?? "";
  const chatId = automationEvent.payload.chatId;
  const workflowInstanceId = event.instanceId;

  if (
    automationEvent.source !== "telegram" ||
    automationEvent.eventType !== "message.received" ||
    (text !== "/pi" && text.startsWith("/"))
  ) {
    return { skipped: true, reason: "not-telegram-pi-message" };
  }

  const telegramActor = automationEvent.actors.initiator;
  if (
    telegramActor.scope !== "external" ||
    telegramActor.source !== "telegram" ||
    telegramActor.type !== "chat" ||
    telegramActor.id !== chatId
  ) {
    return { skipped: true, reason: "invalid-telegram-actor" };
  }

  const linkedIdentity = await step.do("resolve linked telegram user", async () => {
    return await identity.resolveExternal({
      source: "telegram",
      type: "chat",
      id: chatId,
    });
  });
  if (!linkedIdentity) {
    return { skipped: true, reason: "telegram-chat-not-linked" };
  }
  const linkedUser = linkedIdentity.userId;

  const piSessionBinding = await step.do("lookup pi session", async () => {
    return await store.get({
      key: "telegram-pi-session/" + linkedUser,
    });
  });

  const reusableSession = await step.do("check existing pi session", async () => {
    const sessionId = piSessionBinding?.value ?? "";
    if (!sessionId) {
      return { reusable: false, sessionId: "" };
    }

    try {
      await pi.getSession({ sessionId });
      return { reusable: true, sessionId };
    } catch (error) {
      const isMissingSession =
        error !== null &&
        typeof error === "object" &&
        "status" in error &&
        error.status === 404 &&
        "code" in error &&
        error.code === "SESSION_NOT_FOUND";
      if (!isMissingSession) {
        throw error;
      }
      return { reusable: false, sessionId: "" };
    }
  });

  let piSession = { created: false, sessionId: reusableSession.sessionId };
  if (!reusableSession.reusable) {
    const session = await step.do("create pi session", async () => {
      return await pi.createSession({
        requestId: "telegram-user:" + linkedUser,
        name: "Telegram " + chatId,
        instructions:
          "IMPORTANT:ALL non-tool call output will AUTOMATICALLY be " +
          "forwarded to Telegram in Markdown parse mode.",
      });
    });

    await step.do("store pi session binding", async () => {
      await store.set({
        key: "telegram-pi-session/" + linkedUser,
        value: session.sessionId,
        description: "Pi session for Telegram chat " + chatId,
        category: ["telegram", "pi"],
      });
    });

    piSession = { created: true, sessionId: session.sessionId };
  }

  const commandReply = await step.do("reply to pi command if needed", async () => {
    if (text !== "/pi") {
      return { sent: false };
    }

    const prefix = piSession.created ? "Created Pi session: " : "Pi session: ";
    await telegram.sendMessage({
      chatId,
      text: prefix + piSession.sessionId,
      parseMode: "Markdown",
    });
    return { sent: true };
  });

  if (commandReply.sent || !text) {
    return { sessionId: piSession.sessionId };
  }

  await step.do("send telegram typing action", async () => {
    await telegram.sendChatAction({
      chatId,
      action: "typing",
    });
  });

  const assistantText = await step.do("run pi turn", async () => {
    const resp = await pi.runPrompt({
      sessionId: piSession.sessionId,
      requestId: workflowInstanceId + ":run-pi-turn",
      content: text,
    });

    return resp.assistantText;
  });

  await step.do("send pi response if needed", async () => {
    if (!assistantText) {
      return { sent: false };
    }

    await telegram.sendMessage({
      chatId,
      text: assistantText,
      parseMode: "Markdown",
    });
    return { sent: true };
  });

  return { sessionId: piSession.sessionId };
});
