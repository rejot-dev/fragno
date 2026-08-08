/** Stable workflow source corpus owned by the token visualizer tests.
 *
 * Keep these fixtures local: application/scenario changes must not rewrite this package's expectations.
 */
export const WORKFLOW_VISUALIZER_FIXTURES: ReadonlyArray<readonly [path: string, source: string]> =
  [
    [
      "automations/telegram-user-linking.workflow.js",
      `defineWorkflow(
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
    ],
    [
      "automations/telegram-user-pi-linking.workflow.js",
      `defineWorkflow(
  { name: "telegram-user-pi-linking" },
  async (event, step) => {
    const automationEvent = event.payload.automationEvent;

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
            (message.includes("Pi fragment returned 404:") ||
              message.includes("Pi harness returned 404:")) &&
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
    ],
    [
      "automations/pi-default-agent-configure.workflow.js",
      `defineWorkflow(
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
        description: "Default Pi agent for automation-created sessions.",
        category: ["pi"],
      });
    });

    return { stored: true, value };
  },
);
`,
    ],
    [
      "automations/telegram-test-command.workflow.js",
      `defineWorkflow(
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
    ],
    [
      "automations/project-files-configure.workflow.js",
      `defineWorkflow(
  { name: "project-files-configure" },
  async (event, step) => {
    const automationEvent = event.payload.automationEvent;

    if (
      automationEvent.source !== "automations" ||
      automationEvent.eventType !== "project.created"
    ) {
      return { skipped: true, reason: "not-project-created" };
    }

    const projectId = automationEvent.subject?.projectId ?? automationEvent.payload.project?.id;
    if (!projectId) {
      throw new Error("project.created event is missing subject.projectId.");
    }

    return await step.do("configure project database filesystem", async () => {
      return await internal.projectFilesConfigure({ projectId });
    });
  },
);
`,
    ],
    [
      "automations/reson8-transcribe-oga-upload-v2.workflow.js",
      `defineWorkflow({ name: "reson8-transcribe-oga-upload-v2" }, async (_event, step) => {
  await step.do("request OGA upload", async () => ({
    $ui: {
      version: 1,
      state: { response: { audio: null } },
      spec: {
        root: "form",
        elements: {
          form: { type: "Stack", props: { gap: "md" }, children: ["heading", "description", "audio", "submit"] },
          heading: { type: "Heading", props: { text: "Transcribe an OGA file", level: 2 }, children: [] },
          description: { type: "Text", props: { text: "The previous upload exceeded a runtime limit. Please upload the OGA file again (maximum 50 MB).", tone: "muted" }, children: [] },
          audio: { type: "FileUpload", props: { label: "OGA audio file", scope: { kind: "current" }, value: { $bindState: "/response/audio" }, accept: [".oga", "audio/ogg"], maxSizeBytes: 52428800, required: true }, children: [] },
          submit: { type: "WorkflowEventButton", props: { label: "Transcribe", eventType: "oga-transcribe-submit-v2", payload: { $state: "/response" }, variant: "primary" }, children: [] }
        }
      }
    }
  }));
  const submitted = await step.waitForEvent("receive OGA upload", { type: "oga-transcribe-submit-v2" });
  const file = submitted.payload?.audio;
  if (!file || file.kind !== "prepared-upload") throw new Error("Please upload an OGA file.");
  try {
    const audio = await step.do("read uploaded audio", async () => context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 }));
    const transcription = await step.do("transcribe with Reson8", async () => context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true }));
    const saved = await step.do("commit uploaded audio", async () => context.current.upload.commitPrepared({ file }));
    return { filename: file.filename, transcription, saved, $ui: { version: 1, state: { filename: file.filename, text: transcription.text }, spec: { root: "result", elements: { result: { type: "Stack", props: { gap: "md" }, children: ["heading", "file", "text"] }, heading: { type: "Heading", props: { text: "Transcription", level: 2 }, children: [] }, file: { type: "Text", props: { text: { $state: "/filename" }, tone: "muted" }, children: [] }, text: { type: "Section", props: { label: "Transcript", variant: "live" }, children: ["transcriptText"] }, transcriptText: { type: "Text", props: { text: { $state: "/text" } }, children: [] } } } } };
  } catch (error) {
    await step.do("discard failed upload", async () => context.current.upload.discardPrepared({ file }));
    throw error;
  }
});
`,
    ],
    [
      "automations/workspace-file-initialization.workflow.js",
      `defineWorkflow(
  { name: "workspace-file-initialization" },
  async (event, step) => {
    const automationEvent = event.payload.automationEvent;

    if (
      automationEvent.source !== "auth" ||
      automationEvent.eventType !== "organization.created"
    ) {
      return { skipped: true, reason: "not-organization-created" };
    }

    const orgId = automationEvent.subject?.orgId;
    if (!orgId) {
      throw new Error("organization.created event is missing subject.orgId.");
    }
    const org = context.org(orgId);

    const configured = await step.do("configure upload database connection", async () => {
      await org.connections.configure({
        id: "upload",
        payload: { provider: "database" },
      });

      return { configured: true, id: "upload", provider: "database" };
    });

    const seeded = await step.do("seed workspace starter files", async () => {
      return await org.internal.filesSeedExecute({});
    });

    const automationRoutes = await step.do("seed starter automation routes", async () => {
      return await org.internal.automationsRoutesSeedStarter({});
    });

    return { ...configured, seeded, automationRoutes };
  },
);
`,
    ],
  ] as const;
