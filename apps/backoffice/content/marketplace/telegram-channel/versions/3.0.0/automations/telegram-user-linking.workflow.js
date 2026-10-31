export default defineWorkflow({ name: "telegram-user-linking" }, async (event, step) => {
  const automationEvent = /** @type {WorkflowEvent<{chatId: string}>} */ (event);
  const workflowInstanceId = event.instanceId;
  const chatId = automationEvent.payload.chatId;

  const telegramActor = automationEvent.actors.initiator;
  if (
    telegramActor.scope !== "external" ||
    telegramActor.source !== "telegram" ||
    telegramActor.type !== "user"
  ) {
    return { skipped: true, reason: "invalid-telegram-actor" };
  }
  const telegramUserId = telegramActor.id;

  // Everyone in a group could open the claim link and take over the sender's link. In a private
  // chat, Telegram's chat ID is the sender's user ID.
  if (chatId !== telegramUserId) {
    await step.do("ask to link in a private chat", async () => {
      await integrations.execute({
        connectionId: "backoffice#telegram",
        actionId: "messages.send",
        input: {
          chatId,
          text: "Send /start to me in a private chat to link your Telegram account.",
          parseMode: "Markdown",
          disableWebPagePreview: false,
          replyToMessageId: null,
        },
      });
    });
    return { skipped: true, reason: "not-private-chat" };
  }

  const linkedIdentity = await step.do("resolve existing telegram user link", async () => {
    return await identity.resolveExternal({
      source: "telegram",
      type: "user",
      id: telegramUserId,
    });
  });

  if (linkedIdentity) {
    await step.do("send already linked telegram message", async () => {
      await integrations.execute({
        connectionId: "backoffice#telegram",
        actionId: "messages.send",
        input: {
          chatId,
          text: "Your Telegram account is already linked.",
          parseMode: "Markdown",
          disableWebPagePreview: false,
          replyToMessageId: null,
        },
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
    await integrations.execute({
      connectionId: "backoffice#telegram",
      actionId: "messages.send",
      input: {
        chatId,
        text: "Open this link to finish linking your Telegram account: " + claim.url,
        parseMode: "Markdown",
        disableWebPagePreview: false,
        replyToMessageId: null,
      },
    });
  });

  const completed = await step.waitForEvent("identity-claim-completed", {
    type: "identity-claim-completed",
    timeout: "15 minutes",
  });
  const completedEvent = /** @type {{
   *   payload: {otpId: string};
   *   actors: {initiator: {source: string; type: string; id: string}};
   *   subject: {userId: string};
   * }} */ (completed.payload);
  const completedOtpId = completedEvent.payload.otpId;
  const completedActor = completedEvent.actors.initiator;
  const subjectUserId = completedEvent.subject.userId;

  if (completedOtpId !== claim.otpId) {
    return { linked: false, reason: "claim-mismatch" };
  }

  if (
    completedActor.source !== "telegram" ||
    completedActor.type !== "user" ||
    completedActor.id !== telegramUserId
  ) {
    return { linked: false, reason: "identity-mismatch" };
  }

  await step.do("send telegram user linked message", async () => {
    await integrations.execute({
      connectionId: "backoffice#telegram",
      actionId: "messages.send",
      input: {
        chatId,
        text: "Your Telegram account is now linked.",
        parseMode: "Markdown",
        disableWebPagePreview: false,
        replyToMessageId: null,
      },
    });
  });

  return { linked: true, userId: subjectUserId, otpId: claim.otpId };
});
