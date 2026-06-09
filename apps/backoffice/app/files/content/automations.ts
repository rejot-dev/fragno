import type { FileSystemArtifact } from "../types";

export const STATIC_STARTER_ROOT = "/starter";

export const STARTER_AUTOMATION_SCRIPT_PATHS = {
  router: "automations/scripts/router.cm.js",
  telegramClaimLinkingStart: "automations/scripts/router.cm.js",
  telegramClaimLinking: "automations/scripts/telegram-claim-linking.workflow.js",
  telegramDelayedTestReply: "automations/scripts/telegram-delayed-test-reply.workflow.js",
  telegramPiSession: "automations/scripts/telegram-pi-session.workflow.js",
} as const;

export const STARTER_AUTOMATION_CONTENT: Record<string, FileSystemArtifact> = {
  "automations/scripts/router.cm.js": `async () => {
  const event = await state.readFile("/context/event.json").then(JSON.parse);

  const instanceIdForEvent = (prefix) => {
    return prefix + "-" + event.id.replace(/[^a-zA-Z0-9-_]/g, "-");
  };

  if (event.source === "pi" && event.eventType === "capability.configured") {
    const harness = event.payload.harnesses[0];
    const model = event.payload.modelCatalog[0];

    if (harness && model) {
      await identity.bindActor({
        source: "pi",
        key: "pi-default-agent",
        value: harness.id + "::" + model.provider + "::" + model.name,
        description: "Default Pi agent for this organisation.",
      });
    }
  }

  if (
    event.source === "telegram" &&
    event.eventType === "message.received" &&
    typeof event.payload.text === "string"
  ) {
    const text = event.payload.text;

    if (text === "/start") {
      const instanceId = instanceIdForEvent("telegram-link");
      await workflow.createInstance({
        workflowName: "automation-codemode-script",
        remoteWorkflowName: "telegram-claim-linking",
        instanceId,
        params: {
          automationEvent: event,
          workflowInstanceId: instanceId,
          workflowScriptPath:
            "/starter/automations/scripts/telegram-claim-linking.workflow.js",
        },
      });
    }

    if (text === "/test") {
      const instanceId = instanceIdForEvent("telegram-test");
      await workflow.createInstance({
        workflowName: "automation-codemode-script",
        remoteWorkflowName: "telegram-delayed-test-reply",
        instanceId,
        params: {
          automationEvent: event,
          workflowScriptPath:
            "/starter/automations/scripts/telegram-delayed-test-reply.workflow.js",
        },
      });
    }

    if (text === "/pi" || !text.startsWith("/")) {
      const defaultAgentBinding = await identity.lookupBinding({
        source: "pi",
        key: "pi-default-agent",
      });
      const defaultAgent = defaultAgentBinding?.value ?? "";

      if (defaultAgent) {
        const instanceId = instanceIdForEvent("telegram-pi");
        await workflow.createInstance({
          workflowName: "automation-codemode-script",
          remoteWorkflowName: "telegram-pi-session",
          instanceId,
          params: {
            automationEvent: event,
            workflowScriptPath:
              "/starter/automations/scripts/telegram-pi-session.workflow.js",
          },
        });
      }
    }
  }

  if (event.source === "otp" && event.eventType === "identity.claim.completed") {
    const linkSource = event.payload.linkSource;
    const otpId = event.payload.otpId ?? (event.payload.externalActorId ? "otp-" + event.payload.externalActorId : "");

    if (linkSource === "telegram") {
      const workflowBinding = await identity.lookupBinding({
        source: "telegram-claim-workflow",
        key: otpId,
      });
      const instanceId = workflowBinding?.value ?? "";

      if (instanceId) {
        await workflow.sendEvent({
          workflowName: "automation-codemode-script",
          instanceId,
          type: "identity-claim-completed",
          payload: event,
        });
      }
    }
  }
};
`,
  "automations/scripts/telegram-claim-linking.workflow.js": `defineWorkflow(
  { name: "telegram-claim-linking" },
  async (event, step) => {
    const automationEvent = event.payload.automationEvent;
    const workflowInstanceId = event.payload.workflowInstanceId;
    const chatId = automationEvent.payload.chatId;

    const linkedUser = await step.do("lookup existing link", async () => {
      return await identity.lookupBinding({
        source: "telegram",
        key: chatId,
      });
    });

    const alreadyLinkedReply = await step.do(
      "send already linked message if needed",
      async () => {
        if (!linkedUser?.value) {
          return { sent: false };
        }

        await telegram.sendMessage({
          chatId,
          text: "This Telegram chat is already linked.",
          parseMode: "Markdown",
        });
        return { sent: true };
      },
    );

    if (alreadyLinkedReply.sent) {
      return {
        linked: true,
        alreadyLinked: true,
        userId: linkedUser.value,
      };
    }

    const claim = await step.do("create identity claim", async () => {
      const claim = await otp.createIdentityClaim({
        source: "telegram",
        externalActorId: chatId,
      });

      await identity.bindActor({
        source: "telegram-claim-workflow",
        key: claim.otpId,
        value: workflowInstanceId,
        description: "Telegram claim workflow for chat " + chatId,
      });
      await telegram.sendMessage({
        chatId,
        text: "Open this link to finish linking your Telegram account: " +
          claim.url,
        parseMode: "Markdown",
      });
      return claim;
    });

    const completed = await step.waitForEvent("identity-claim-completed", {
      type: "identity-claim-completed",
      timeout: "15 minutes",
    });
    const completedEvent = completed.payload;
    const completedOtpId = completedEvent.payload.otpId;
    const linkSource = completedEvent.payload.linkSource;
    const externalActorId = completedEvent.payload.externalActorId;
    const subjectUserId = completedEvent.subject.userId;

    if (completedOtpId !== claim.otpId) {
      return { linked: false, reason: "claim-mismatch" };
    }

    if (linkSource !== "telegram") {
      return { linked: false, reason: "not-telegram" };
    }

    return await step.do("bind telegram actor", async () => {
      try {
        await identity.bindActor({
          source: linkSource,
          key: externalActorId,
          value: subjectUserId,
        });
        await telegram.sendMessage({
          chatId: externalActorId,
          text: "Your Telegram chat is now linked.",
          parseMode: "Markdown",
        });
        return { linked: true, userId: subjectUserId, otpId: claim.otpId };
      } catch (error) {
        await telegram.sendMessage({
          chatId: externalActorId,
          text: "We couldn't link your Telegram chat. Please try again.",
          parseMode: "Markdown",
        });
        throw error;
      }
    });
  },
);
`,
  "automations/scripts/telegram-delayed-test-reply.workflow.js": `defineWorkflow(
  { name: "telegram-delayed-test-reply" },
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
  "automations/scripts/telegram-pi-session.workflow.js": `defineWorkflow(
  { name: "telegram-pi-session" },
  async (event, step) => {
    const automationEvent = event.payload.automationEvent;
    const text = automationEvent.payload.text ?? "";
    const chatId = automationEvent.payload.chatId;
    const externalActorId = automationEvent.actor.externalId;

    const linkedBinding = await step.do("lookup linked user", async () => {
      return await identity.lookupBinding({
        source: "telegram",
        key: externalActorId,
      });
    });
    const linkedUser = linkedBinding?.value ?? "";

    if (!linkedUser) {
      return { skipped: true, reason: "telegram-chat-not-linked" };
    }

    const defaultAgentBinding = await step.do("lookup default pi agent", async () => {
      return await identity.lookupBinding({
        source: "pi",
        key: "pi-default-agent",
      });
    });
    const defaultAgent = defaultAgentBinding?.value ?? "";

    if (!defaultAgent) {
      return { skipped: true, reason: "missing-default-agent" };
    }

    const piSessionBinding = await step.do("lookup pi session", async () => {
      return await identity.lookupBinding({
        source: "telegram-pi-session",
        key: linkedUser,
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

    const piSession = await step.do("ensure pi session", async () => {
      if (reusableSession.reusable) {
        return { created: false, sessionId: reusableSession.sessionId };
      }

      const session = await pi.createSession({
        agent: defaultAgent,
        name: "Telegram " + chatId,
        tags: ["telegram", "auto-session"],
        systemMessage:
          "IMPORTANT:ALL non-tool call output will AUTOMATICALLY be " +
          "forwarded to Telegram in Markdown parse mode.",
      });

      await identity.bindActor({
        source: "telegram-pi-session",
        key: linkedUser,
        value: session.id,
        description: "Pi session for Telegram chat " + externalActorId,
      });

      return { created: true, sessionId: session.id };
    });

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

    const assistantText = await step.do("run pi turn if needed", async () => {
      if (commandReply.sent || !text) {
        return "";
      }

      await telegram.sendChatAction({
        chatId,
        action: "typing",
      });

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
