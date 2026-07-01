/**
 * Verbatim copies of the default automation scripts shipped by the backoffice app
 * (apps/backoffice/app/files/content/system-automations.ts and starter-automations.ts).
 *
 * Kept here so the visualizer's tests exercise the *real* default workflows without
 * taking a cross-package dependency on the app. If the shipped defaults change, update
 * these fixtures to match — the tests then guard that the defaults still parse cleanly.
 */

export const WORKSPACE_FILE_INITIALIZATION = `defineWorkflow(
  { name: "workspace-file-initialization" },
  async (event, step) => {
    const automationEvent = event.payload.automationEvent;

    if (
      automationEvent.source !== "auth" ||
      automationEvent.eventType !== "organization.created"
    ) {
      return { skipped: true, reason: "not-organization-created" };
    }

    const configured = await step.do("configure upload database connection", async () => {
      await connections.configure({
        id: "upload",
        payload: { provider: "database" },
      });

      return { configured: true, id: "upload", provider: "database" };
    });

    const seeded = await step.do("seed workspace starter files", async () => {
      return await internal.filesSeedExecute({});
    });

    const codemodeTypes = await step.do("write codemode dts", async () => {
      return await internal.codemodeTypesSync({});
    });

    return { ...configured, seeded, codemodeTypes };
  },
);
`;

export const CODEMODE_TYPES_REFRESH = `defineWorkflow(
  { name: "codemode-types-refresh" },
  async (_event, step) => {
    return await step.do("sync codemode dts", async () => {
      return await internal.codemodeTypesSync({});
    });
  },
);
`;

export const TELEGRAM_USER_LINKING = `defineWorkflow(
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
`;

export const TELEGRAM_TEST_COMMAND = `defineWorkflow(
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
`;

export const TELEGRAM_USER_PI_LINKING = `defineWorkflow(
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

    return { sessionId: piSession.sessionId };
  },
);
`;

/** Event catalog covering the default automation events. */
export const DEFAULT_EVENT_CATALOG = [
  { source: "auth", eventType: "organization.created", label: "Organization created" },
  { source: "telegram", eventType: "message.received", label: "Telegram message" },
  { source: "pi", eventType: "capability.configured", label: "PI capability configured" },
  { source: "otp", eventType: "identity.claim.completed", label: "Identity claim completed" },
  { source: "mcp", eventType: "server.configuration.changed", label: "MCP config changed" },
];
