import { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES } from "@/fragno/automation/contracts";
import { AUTOMATION_SCRIPT_ENGINES } from "@/fragno/automation/engines";

import type { FileSystemArtifact } from "../types";

export const STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH = "automations/bindings.json";

/**
 * Full starter automation bindings: trigger metadata, manifest script descriptor (absolute path under /workspace), and file body.
 * Order: telegram claim start → OTP complete → Telegram /test sleep reply → Pi session ensure.
 */
const STARTER_AUTOMATION_BINDINGS = [
  {
    id: "telegram-claim-linking-start",
    source: AUTOMATION_SOURCES.telegram,
    eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
    enabled: false,
    script: {
      key: "telegram-claim-linking.start",
      name: "Telegram claim linking start",
      engine: AUTOMATION_SCRIPT_ENGINES.codemodeWorkflow,
      path: "/workspace/automations/scripts/telegram-claim-linking.start.workflow.cm.js",
      version: 1,
      agent: null,
      env: {},
    },
    content: `defineWorkflow({ name: "telegram-claim-linking-start" }, async ({ payload }, step) => {
  const event = await step.do("read event", () => payload.event);
  const text = event?.payload?.text ?? "";
  const source = event?.source ?? "";
  const externalActorId = event?.actor?.externalId ?? "";

  if (text !== "/start") {
    return { skipped: true, reason: "not-start-command" };
  }

  const linkedUser = await step.do("lookup binding", () =>
    automations.lookupBinding({
      source,
      key: externalActorId,
    }),
  );

  if (linkedUser?.value) {
    await step.do("send already-linked message", () =>
      telegram.sendMessage({
        chatId: externalActorId,
        text: "This Telegram chat is already linked.",
        parseMode: "Markdown",
      }),
    );
    return { linked: true };
  }

  const claim = await step.do("create claim", () =>
    otp.createIdentityClaim({
      source,
      externalActorId,
    }),
  );

  if (!claim?.url) {
    throw new Error("otp.createIdentityClaim did not return a URL");
  }

  await step.do("send claim link", () =>
    telegram.sendMessage({
      chatId: externalActorId,
      text: "Open this link to finish linking your Telegram account: " + claim.url,
      parseMode: "Markdown",
    }),
  );

  return { linked: false, claimCreated: true };
});
`,
  },
  {
    id: "telegram-claim-linking-complete",
    source: AUTOMATION_SOURCES.otp,
    eventType: AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted,
    enabled: false,
    script: {
      key: "telegram-claim-linking.complete",
      name: "Telegram claim linking completion",
      engine: AUTOMATION_SCRIPT_ENGINES.codemode,
      path: "/workspace/automations/scripts/telegram-claim-linking.complete.cm.js",
      version: 1,
      agent: null,
      env: {},
    },
    content: `async () => {
  const event = JSON.parse(await state.readFile("/context/event.json"));
  const linkSource = event?.payload?.linkSource ?? "";
  const externalActorId = event?.payload?.externalActorId ?? "";
  const subjectUserId = event?.subject?.userId ?? "";

  const replyLinkingStatus = async (text) => {
    await telegram.sendMessage({
      chatId: externalActorId,
      text,
      parseMode: "Markdown",
    });
  };

  if (linkSource !== "telegram") {
    return;
  }

  if (!externalActorId) {
    throw new Error("Missing externalActorId in identity claim payload");
  }

  if (!subjectUserId) {
    await replyLinkingStatus("We couldn't link your Telegram chat. Please try again.");
    throw new Error("Missing subject.userId in event");
  }

  try {
    await automations.bindActor({
      source: linkSource,
      key: externalActorId,
      value: subjectUserId,
    });
    await replyLinkingStatus("Your Telegram chat is now linked.");
  } catch (error) {
    await replyLinkingStatus("We couldn't link your Telegram chat. Please try again.");
    throw error;
  }
};
`,
  },
  {
    id: "telegram-pi-session-ensure",
    source: AUTOMATION_SOURCES.telegram,
    eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
    enabled: false,
    script: {
      key: "telegram-pi-session.ensure",
      name: "Telegram Pi session ensure (linked chat)",
      engine: AUTOMATION_SCRIPT_ENGINES.codemode,
      path: "/workspace/automations/scripts/telegram-pi-session.ensure.cm.js",
      version: 1,
      agent: null,
      env: {},
    },
    content: `async () => {
  if (typeof pi === "undefined") {
    return;
  }

  const [event, env] = await Promise.all([
    state.readFile("/context/event.json").then(JSON.parse),
    state.readFile("/context/env.json").then(JSON.parse),
  ]);

  const defaultAgent = env?.PI_DEFAULT_AGENT ?? "";
  if (!defaultAgent) {
    return;
  }

  const externalActorId = event?.actor?.externalId ?? "";
  const text = event?.payload?.text ?? "";
  const chatId = event?.payload?.chatId ?? "";
  const telegramChatId = chatId || externalActorId;

  // Only bootstrap Pi sessions for identity-linked Telegram chats.
  const linkedBinding = await automations.lookupBinding({
    source: "telegram",
    key: externalActorId,
  });
  const linkedUser = linkedBinding?.value ?? "";

  if (!linkedUser) {
    return;
  }

  const bindingSource = "telegram-pi-session";
  // Use the linked user id as the storage key so sessions are per-user (not per-chat).
  const bindingKey = linkedUser;

  const piSessionBinding = await automations.lookupBinding({
    source: bindingSource,
    key: bindingKey,
  });
  let piSessionId = piSessionBinding?.value ?? "";

  let terminalSession = false;
  if (piSessionId) {
    try {
      const session = await pi.getSession({ sessionId: piSessionId });
      const sessionStatus = session?.workflow?.status ?? session?.status ?? "";

      if (["terminated", "complete", "errored", ""].includes(sessionStatus)) {
        terminalSession = true;
      }
    } catch {
      terminalSession = true;
    }
  }

  if (!piSessionId || terminalSession) {
    const sessionName = "Telegram " + telegramChatId;
    const session = await pi.createSession({
      agent: defaultAgent,
      name: sessionName,
      tags: ["telegram", "auto-session"],
      systemMessage:
        "IMPORTANT:ALL non-tool call output will AUTOMATICALLY be forwarded to Telegram in Markdown parse mode.",
    });
    const newSessionId = session?.id ?? "";

    if (!newSessionId) {
      throw new Error("pi.createSession did not return a session id");
    }

    await automations.bindActor({
      source: bindingSource,
      key: bindingKey,
      value: newSessionId,
      description: "Pi session for Telegram chat " + externalActorId,
    });

    piSessionId = newSessionId;

    if (text === "/pi") {
      await telegram.sendMessage({
        chatId: telegramChatId,
        text: "Created Pi session: " + newSessionId,
        parseMode: "Markdown",
      });
      return;
    }
  }

  if (!text || text === "/pi") {
    return;
  }

  await telegram.sendChatAction({
    chatId: telegramChatId,
    action: "typing",
  });

  const turn = await pi.runTurn({
    sessionId: piSessionId,
    text,
  });
  const assistantText = turn?.assistantText ?? "";

  if (assistantText) {
    await telegram.sendMessage({
      chatId: telegramChatId,
      text: assistantText,
      parseMode: "Markdown",
    });
  }
};
`,
  },
  {
    id: "telegram-test-sleep-reply",
    source: AUTOMATION_SOURCES.telegram,
    eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
    enabled: true,
    triggerOrder: 100,
    script: {
      key: "telegram-test.sleep-reply",
      name: "Telegram /test delayed reply",
      engine: AUTOMATION_SCRIPT_ENGINES.codemodeWorkflow,
      path: "/workspace/automations/scripts/telegram-test.sleep-reply.workflow.cm.js",
      version: 1,
      agent: null,
      env: {},
    },
    content: `defineWorkflow({ name: "telegram-test-sleep-reply" }, async ({ payload }, step) => {
  const event = await step.do("read event", () => payload.event);
  const text = event?.payload?.text ?? "";
  const externalActorId = event?.actor?.externalId ?? "";
  const chatId = event?.payload?.chatId ?? externalActorId;

  if (text !== "/test") {
    return { skipped: true, reason: "not-test-command" };
  }

  if (!chatId) {
    throw new Error("Missing Telegram chat id for /test reply");
  }

  await step.sleep("wait 3 seconds", "3 seconds");

  await step.do("send delayed test reply", () =>
    telegram.sendMessage({
      chatId,
      text: "Delayed /test reply after 3 seconds.",
      parseMode: "Markdown",
    }),
  );

  return { replied: true };
});
`,
  },
] as const;

export const STARTER_AUTOMATION_SCRIPT_PATHS = {
  telegramClaimLinkingStart: STARTER_AUTOMATION_BINDINGS[0].script.path.slice("/workspace/".length),
  telegramClaimLinkingComplete: STARTER_AUTOMATION_BINDINGS[1].script.path.slice(
    "/workspace/".length,
  ),
  telegramPiSessionEnsure: STARTER_AUTOMATION_BINDINGS[2].script.path.slice("/workspace/".length),
  telegramTestSleepReply: STARTER_AUTOMATION_BINDINGS[3].script.path.slice("/workspace/".length),
} as const;

const STARTER_AUTOMATION_MANIFEST = {
  version: 1 as const,
  bindings: STARTER_AUTOMATION_BINDINGS.map((b) => ({
    id: b.id,
    source: b.source,
    eventType: b.eventType,
    enabled: b.enabled,
    script: b.script,
  })),
};

export const STARTER_AUTOMATION_CONTENT = {
  [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: `${JSON.stringify(STARTER_AUTOMATION_MANIFEST, null, 2)}\n`,
  ...Object.fromEntries(
    STARTER_AUTOMATION_BINDINGS.map((b) => [b.script.path.slice("/workspace/".length), b.content]),
  ),
} satisfies Record<string, FileSystemArtifact>;
