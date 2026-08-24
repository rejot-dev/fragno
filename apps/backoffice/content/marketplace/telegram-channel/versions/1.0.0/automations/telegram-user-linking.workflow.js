defineWorkflow({ name: "telegram-user-linking" }, async (event, step) => {
  const automationEvent = event;
  const workflowInstanceId = event.instanceId;
  const chatId = automationEvent.payload.chatId;

  if (
    automationEvent.source !== "telegram" ||
    automationEvent.eventType !== "message.received" ||
    automationEvent.payload.text !== "/start"
  ) {
    return { skipped: true, reason: "not-telegram-start" };
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

  const linkedIdentity = await step.do("resolve existing telegram user link", async () => {
    return await identity.resolveExternal({
      source: "telegram",
      type: "chat",
      id: chatId,
    });
  });

  if (linkedIdentity) {
    await step.do("send already linked telegram message", async () => {
      await telegram.sendMessage({
        chatId,
        text: "This Telegram chat is already linked.",
        parseMode: "Markdown",
      });
    });

    return {
      linked: true,
      alreadyLinked: true,
      userId: linkedIdentity.userId,
    };
  }

  const claim = await step.do("create telegram identity claim", async () => {
    return await otp.createIdentityClaim({});
  });

  await step.do("store telegram claim workflow binding", async () => {
    await store.set({
      key: "telegram/claim-workflow/" + claim.otpId,
      value: workflowInstanceId,
      description: "Workflow waiting for Telegram identity claim " + claim.otpId,
      category: ["system", "telegram", "otp"],
    });
  });

  await step.do("send telegram identity claim link", async () => {
    await telegram.sendMessage({
      chatId,
      text: "Open this link to finish linking your Telegram account: " + claim.url,
      parseMode: "Markdown",
    });
  });

  const completed = await step.waitForEvent("identity-claim-completed", {
    type: "identity-claim-completed",
    timeout: "15 minutes",
  });
  const completedEvent = completed.payload;
  const completedOtpId = completedEvent.payload.otpId;
  const completedActor = completedEvent.actors.initiator;
  const completedActorId = completedActor.id;
  const subjectUserId = completedEvent.subject.userId;

  if (completedOtpId !== claim.otpId) {
    return { linked: false, reason: "claim-mismatch" };
  }

  if (
    completedActor.source !== "telegram" ||
    completedActor.type !== "chat" ||
    completedActorId !== chatId
  ) {
    return { linked: false, reason: "identity-mismatch" };
  }

  await step.do("send telegram user linked message", async () => {
    await telegram.sendMessage({
      chatId,
      text: "Your Telegram chat is now linked.",
      parseMode: "Markdown",
    });
  });

  return { linked: true, userId: subjectUserId, otpId: claim.otpId };
});
