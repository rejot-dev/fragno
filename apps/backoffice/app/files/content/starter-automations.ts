import type { FileContent } from "../interface";

export const STARTER_AUTOMATION_SCRIPT_PATHS = {
  telegramUserLinking: "automations/telegram-user-linking.workflow.js",
  telegramUserPiLinking: "automations/telegram-user-pi-linking.workflow.js",
} as const;

export const WORKSPACE_STARTER_AUTOMATION_CONTENT: Record<string, FileContent> = {
  "automations/telegram-user-linking.workflow.js": `defineWorkflow(
  { name: "telegram-user-linking" },
  async (event, step) => {
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
        text: "Open this link to finish linking your Telegram account: " +
          claim.url,
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
  },
);
`,
  "automations/telegram-user-pi-linking.workflow.js": `defineWorkflow(
  { name: "telegram-user-pi-linking" },
  async (event, step) => {
    const automationEvent = event;

    const text = automationEvent.payload.text ?? "";
    const chatId = automationEvent.payload.chatId;

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

    const reusableSession = await step.do(
      "check existing pi session",
      async () => {
        const sessionId = piSessionBinding?.value ?? "";
        if (!sessionId) {
          return { reusable: false, sessionId: "" };
        }

        try {
          const session = await pi.getSession({ sessionId });
          const status = session.workflow?.status ?? session.status ?? "";
          if (["terminated", "complete", "errored", ""].includes(status)) {
            return { reusable: false, sessionId: "" };
          }

          return { reusable: true, sessionId };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isMissingSession =
            (message.includes("Pi fragment returned 404:") ||
              message.includes("Pi returned 404:")) &&
            message.includes("Session ") &&
            message.includes(" not found.");
          if (!isMissingSession) {
            throw error;
          }
          return { reusable: false, sessionId: "" };
        }
      },
    );

    let piSession = { created: false, sessionId: reusableSession.sessionId };
    if (!reusableSession.reusable) {
      const session = await step.do("create pi session", async () => {
        return await pi.createSession({
          name: "Telegram " + chatId,
          tags: ["telegram", "auto-session"],
          systemMessage:
            "IMPORTANT:ALL non-tool call output will AUTOMATICALLY be " +
            "forwarded to Telegram in Markdown parse mode.",
        });
      });

      await step.do("store pi session binding", async () => {
        await store.set({
          key: "telegram-pi-session/" + linkedUser,
          value: session.id,
          description: "Pi session for Telegram chat " + chatId,
          category: ["telegram", "pi"],
        });
      });

      piSession = { created: true, sessionId: session.id };
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
      const resp = await pi.runTurn({
        sessionId: piSession.sessionId,
        text,
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
  },
);
`,
};
