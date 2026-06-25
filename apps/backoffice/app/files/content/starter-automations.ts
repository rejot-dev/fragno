import type { FileSystemArtifact } from "../types";

export const STARTER_AUTOMATION_SCRIPT_PATHS = {
  telegramUserLinking: "automations/telegram-user-linking.workflow.js",
  telegramUserPiLinking: "automations/telegram-user-pi-linking.workflow.js",
  telegramTestCommand: "automations/telegram-test-command.workflow.js",
  piDefaultAgentConfigure: "automations/pi-default-agent-configure.workflow.js",
} as const;

export const WORKSPACE_STARTER_AUTOMATION_CONTENT: Record<string, FileSystemArtifact> = {
  "automations/telegram-user-linking.workflow.js": `defineWorkflow(
  { name: "telegram-user-linking" },
  async (event, step) => {
    const automationEvent = event.payload.automationEvent;
    const workflowInstanceId = event.payload.workflowInstanceId;
    const chatId = automationEvent.payload.chatId;

    if (
      automationEvent.source !== "telegram" ||
      automationEvent.eventType !== "message.received" ||
      automationEvent.payload.text !== "/start"
    ) {
      return { skipped: true, reason: "not-telegram-start" };
    }

    const linkedUser = await step.do("lookup existing telegram user link", async () => {
      return await store.get({
        key: "telegram/" + chatId,
      });
    });

    if (linkedUser?.value) {
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
        userId: linkedUser.value,
      };
    }

    const claim = await step.do("create telegram identity claim", async () => {
      return await otp.createIdentityClaim({
        actor: {
          scope: "external",
          source: "telegram",
          type: "chat",
          id: chatId,
        },
      });
    });

    await step.do("store telegram claim workflow binding", async () => {
      await store.set({
        key: "telegram/claim-workflow/" + claim.otpId,
        value: workflowInstanceId,
        actor: automationEvent.actor,
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
    const completedActor = completedEvent.actor;
    const completedActorId = completedActor.id;
    const subjectUserId = completedEvent.subject.userId;

    if (completedOtpId !== claim.otpId) {
      return { linked: false, reason: "claim-mismatch" };
    }

    if (completedActor.source !== "telegram") {
      return { linked: false, reason: "not-telegram" };
    }

    await step.do("bind telegram user", async () => {
      await store.set({
        key: completedActor.source + "/" + completedActorId,
        value: subjectUserId,
        actor: completedActor,
        description: "Backoffice user linked to Telegram chat " + completedActorId,
        category: ["telegram", "identity"],
      });
    });

    await step.do("send telegram user linked message", async () => {
      await telegram.sendMessage({
        chatId: completedActorId,
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
    const automationEvent = event.payload.automationEvent;

    const text = automationEvent.payload.text ?? "";
    const chatId = automationEvent.payload.chatId;
    const automationActorId = automationEvent.actor.id;

    if (
      automationEvent.source !== "telegram" ||
      automationEvent.eventType !== "message.received" ||
      (text !== "/pi" && text.startsWith("/"))
    ) {
      return { skipped: true, reason: "not-telegram-pi-message" };
    }

    const linkedBinding = await step.do("lookup linked telegram user", async () => {
      return await store.get({
        key: "telegram/" + automationActorId,
      });
    });
    const linkedUser = linkedBinding?.value ?? "";

    if (!linkedUser) {
      return { skipped: true, reason: "telegram-chat-not-linked" };
    }

    const defaultAgentBinding = await step.do("lookup default pi agent", async () => {
      return await store.get({
        key: "pi/pi-default-agent",
      });
    });
    const defaultAgent = defaultAgentBinding?.value ?? "";

    if (!defaultAgent) {
      return { skipped: true, reason: "missing-default-agent" };
    }

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
            message.includes("Pi fragment returned 404:") &&
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
          agent: defaultAgent,
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
          actor: automationEvent.actor,
          description: "Pi session for Telegram chat " + automationActorId,
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
  "automations/pi-default-agent-configure.workflow.js": `defineWorkflow(
  { name: "pi-default-agent-configure" },
  async (event, step) => {
    const automationEvent = event.payload.automationEvent;

    if (
      automationEvent.source !== "pi" ||
      automationEvent.eventType !== "capability.configured"
    ) {
      return { skipped: true, reason: "not-pi-capability-configured" };
    }

    const harnessId = automationEvent.payload?.harnesses?.[0]?.id;
    const modelProvider = automationEvent.payload?.modelCatalog?.[0]?.provider;
    const modelName = automationEvent.payload?.modelCatalog?.[0]?.name;

    if (
      typeof harnessId !== "string" ||
      typeof modelProvider !== "string" ||
      typeof modelName !== "string"
    ) {
      return { skipped: true, reason: "missing-pi-default-agent-parts" };
    }

    const value = harnessId + "::" + modelProvider + "::" + modelName;

    await step.do("store default pi agent", async () => {
      await store.set({
        key: "pi/pi-default-agent",
        value,
        actor: automationEvent.actor,
        description: "Default Pi agent for automation-created sessions.",
        category: ["pi"],
      });
    });

    return { stored: true, value };
  },
);
`,
  "automations/telegram-test-command.workflow.js": `defineWorkflow(
  { name: "telegram-test-command" },
  async (event, step) => {
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
  },
);
`,
};
