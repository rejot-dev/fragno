import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import { z } from "zod";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import type { PiBashRuntime } from "../pi-bash-runtime";
import { builtinAutomationBindings, builtinAutomationScripts } from "./builtins";
import type { AutomationEvent, AutomationSourceAdapterRegistry } from "./contracts";
import { automationFragmentDefinition, type AutomationPiBashContext } from "./definition";
import { automationFragmentRoutes } from "./routes";
import { automationFragmentSchema } from "./schema";

const replyCalls: string[] = [];
const issueIdentityClaimMock = vi.fn(async ({ externalActorId }: { externalActorId: string }) => ({
  url: `https://example.com/claims/${externalActorId}`,
  externalId: externalActorId,
  code: "123456",
  type: "otp",
}));
const automationEnv = {
  DOCS_PUBLIC_BASE_URL: "https://example.com",
  OTP: {
    idFromName: vi.fn((orgId: string) => `otp:${orgId}`),
    get: vi.fn(() => ({
      issueIdentityClaim: issueIdentityClaimMock,
    })),
  },
} as unknown as CloudflareEnv;
const createPiSessionMock = vi.fn(async ({ agent }: { agent: string }) => ({
  id: `session-for-${agent}`,
  name: null,
  status: "waiting" as const,
  agent,
  steeringMode: "one-at-a-time" as const,
  metadata: null,
  tags: [],
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
}));
const sourceAdapter = {
  source: "telegram",
  eventSchemas: {
    "message.received": z.object({
      text: z.string().optional(),
      chatId: z.string().optional(),
    }),
  },
  toBashEnv: (event) => ({
    AUTOMATION_TELEGRAM_TEXT:
      typeof event.payload.text === "string" ? event.payload.text : undefined,
    AUTOMATION_TELEGRAM_CHAT_ID:
      typeof event.payload.chatId === "string" ? event.payload.chatId : undefined,
  }),
  reply: vi.fn(async ({ text }: { text: string }) => {
    replyCalls.push(text);
  }),
} satisfies AutomationSourceAdapterRegistry["telegram"];

const buildAutomationTestContext = async (
  config: {
    env?: CloudflareEnv;
    builtinScripts?: typeof builtinAutomationScripts;
    builtinBindings?: typeof builtinAutomationBindings;
    createPiAutomationContext?: (input: {
      event: AutomationEvent;
      idempotencyKey: string;
    }) => AutomationPiBashContext | undefined;
  } = {},
) => {
  return await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "in-memory" })
    .withFragment(
      "automation",
      instantiate(automationFragmentDefinition)
        .withConfig({
          env: config.env ?? automationEnv,
          sourceAdapters: {
            telegram: sourceAdapter,
          },
          createPiAutomationContext: config.createPiAutomationContext,
          builtinScripts: config.builtinScripts,
          builtinBindings: config.builtinBindings,
        })
        .withRoutes([automationFragmentRoutes]),
    )
    .build();
};

const { fragments, test: testContext } = await buildAutomationTestContext();

describe("automation internalIngestEvent", () => {
  const fragment = fragments.automation;
  const source = "telegram";
  const eventType = "message.received";

  const expectAccepted = (result: unknown) => {
    expect(result).toEqual({
      accepted: true,
      eventId: "event-123",
      orgId: undefined,
      source,
      eventType,
    });
  };

  const createScript = async ({
    key,
    script,
    enabled = true,
  }: {
    key: string;
    script: string;
    enabled?: boolean;
  }) => {
    const response = await fragment.fragment.callRoute("POST", "/scripts", {
      body: {
        key,
        name: key,
        engine: "bash",
        script,
        version: 1,
        enabled,
      },
    });

    if (response.type !== "json") {
      throw new Error("Expected JSON response when creating script");
    }

    return response.data.id;
  };

  const createBinding = async ({
    source: bindingSource = source,
    eventType: bindingEventType = eventType,
    scriptId,
    enabled = true,
  }: {
    source?: string;
    eventType?: string;
    scriptId: string;
    enabled?: boolean;
  }) => {
    const response = await fragment.fragment.callRoute("POST", "/bindings", {
      body: {
        source: bindingSource,
        eventType: bindingEventType,
        scriptId,
        enabled,
      },
    });

    if (response.type !== "json") {
      throw new Error("Expected JSON response when creating binding");
    }

    return response.data.id;
  };

  const insertBindingDirectly = async ({
    source: bindingSource = source,
    eventType: bindingEventType = eventType,
    scriptId,
    enabled = true,
  }: {
    source?: string;
    eventType?: string;
    scriptId: string;
    enabled?: boolean;
  }) => {
    await testContext.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(automationFragmentSchema).create("trigger_binding", {
            source: bindingSource,
            eventType: bindingEventType,
            scriptId,
            enabled,
          });
        })
        .execute();
    });
  };

  const ingestEvent = async (overrides: Partial<AutomationEvent> = {}) => {
    const result = await fragment.fragment.callServices(() =>
      fragment.services.ingestEvent({
        id: "event-123",
        source,
        eventType,
        occurredAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        payload: {},
        actor: {
          type: "user",
          externalId: "actor-1",
        },
        ...overrides,
      }),
    );

    await drainDurableHooks(fragment.fragment);
    return result;
  };

  const waitForDistinctBindingTimestamp = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  beforeEach(async () => {
    replyCalls.length = 0;
    vi.clearAllMocks();
    issueIdentityClaimMock.mockClear();
    createPiSessionMock.mockClear();
    await testContext.resetDatabase();
  });

  afterAll(async () => {
    await testContext.cleanup();
  });

  test("runs the internalIngestEvent hook for a matching enabled binding", async () => {
    const scriptId = await createScript({
      key: "reply-on-message",
      script: 'event.reply --text "from-enabled-binding"',
    });

    await createBinding({ scriptId, enabled: true });

    const result = await ingestEvent();

    expectAccepted(result);
    expect(replyCalls).toEqual(["from-enabled-binding"]);
  });

  test("does not execute scripts for disabled bindings", async () => {
    const scriptId = await createScript({
      key: "disabled-binding-script",
      script: 'event.reply --text "should-not-run"',
    });

    await createBinding({ scriptId, enabled: false });

    const result = await ingestEvent();

    expectAccepted(result);
    expect(replyCalls).toEqual([]);
  });

  test("does not execute disabled scripts even when the binding is enabled", async () => {
    const scriptId = await createScript({
      key: "disabled-script",
      script: 'event.reply --text "should-not-run"',
      enabled: false,
    });

    await createBinding({ scriptId, enabled: true });

    const result = await ingestEvent();

    expectAccepted(result);
    expect(replyCalls).toEqual([]);
  });

  test("warns and exits when no matching bindings exist", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await ingestEvent();

      expectAccepted(result);
      expect(replyCalls).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        "No automation binding configured for event",
        expect.objectContaining({
          eventId: "event-123",
          source,
          eventType,
          orgId: undefined,
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("fans out to all enabled bindings that exist in storage for the same event", async () => {
    const firstScriptId = await createScript({
      key: "first-script",
      script: 'event.reply --text "from-first"',
    });
    const secondScriptId = await createScript({
      key: "second-script",
      script: 'event.reply --text "from-second"',
    });
    const disabledScriptId = await createScript({
      key: "disabled-script",
      script: 'event.reply --text "from-disabled-script"',
      enabled: false,
    });
    const disabledBindingScriptId = await createScript({
      key: "disabled-binding-script",
      script: 'event.reply --text "from-disabled-binding"',
    });

    await createBinding({ scriptId: firstScriptId, enabled: true });
    await insertBindingDirectly({ scriptId: secondScriptId, enabled: true });
    await insertBindingDirectly({ scriptId: disabledScriptId, enabled: true });
    await insertBindingDirectly({
      scriptId: disabledBindingScriptId,
      enabled: false,
    });

    const result = await ingestEvent();

    expectAccepted(result);
    expect(replyCalls.sort()).toEqual(["from-first", "from-second"]);
  });

  test("executes stored bindings sequentially in deterministic creation order", async () => {
    const firstScriptId = await createScript({
      key: "sequential-first-script",
      script: ["sleep 0.05", 'event.reply --text "from-first"'].join("\n"),
    });
    const secondScriptId = await createScript({
      key: "sequential-second-script",
      script: 'event.reply --text "from-second"',
    });

    await createBinding({ scriptId: firstScriptId, enabled: true });
    await waitForDistinctBindingTimestamp();
    await insertBindingDirectly({ scriptId: secondScriptId, enabled: true });

    const result = await ingestEvent();

    expectAccepted(result);
    expect(replyCalls).toEqual(["from-first", "from-second"]);
  });

  test("stops executing later stored bindings after an earlier failure", async () => {
    const failingScriptId = await createScript({
      key: "stored-failing-script",
      script: ["sleep 0.05", 'echo "boom" >&2', "exit 9"].join("\n"),
    });
    const skippedScriptId = await createScript({
      key: "stored-skipped-script",
      script: 'event.reply --text "should-not-run"',
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await createBinding({ scriptId: failingScriptId, enabled: true });
      await waitForDistinctBindingTimestamp();
      await insertBindingDirectly({ scriptId: skippedScriptId, enabled: true });

      const result = await ingestEvent();

      expectAccepted(result);
      expect(replyCalls).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        "[fragno-db] Hook failed",
        expect.objectContaining({
          namespace: "automations",
          hookName: "internalIngestEvent",
          error: expect.stringContaining(
            `Automation bash script ${failingScriptId} failed for event event-123 with exit code 9.`,
          ),
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("supports the generic linking slice from inbound event to durable identity binding", async () => {
    const telegramScriptId = await createScript({
      key: "telegram-linking",
      script: [
        'linked_user="$(automations.identity.lookup-binding --source "$AUTOMATION_SOURCE" --external-actor-id "$AUTOMATION_EXTERNAL_ACTOR_ID" --print user-id || true)"',
        'if [ -n "$linked_user" ]; then',
        '  event.reply --text "already-linked:$linked_user"',
        "else",
        '  claim_url="$(otp.identity.create-claim --source "$AUTOMATION_SOURCE" --external-actor-id "$AUTOMATION_EXTERNAL_ACTOR_ID" --print url)"',
        '  event.reply --text "claim:$claim_url"',
        "fi",
      ].join("\n"),
    });
    const otpScriptId = await createScript({
      key: "otp-complete-linking",
      script: [
        'link_source="$(jq -r ".linkSource" /context/payload.json)"',
        'external_actor_id="$(jq -r ".externalActorId" /context/payload.json)"',
        'automations.identity.bind-actor --source "$link_source" --external-actor-id "$external_actor_id" --user-id "$AUTOMATION_SUBJECT_USER_ID" >/dev/null',
      ].join("\n"),
    });

    await createBinding({ scriptId: telegramScriptId, enabled: true });
    await createBinding({
      source: "otp",
      eventType: "identity.claim.completed",
      scriptId: otpScriptId,
      enabled: true,
    });

    const firstTelegramResult = await ingestEvent({
      id: "event-telegram-1",
      orgId: "org-1",
      payload: { text: "/start" },
      actor: {
        type: "external",
        externalId: "chat-1",
      },
    });

    expect(firstTelegramResult).toEqual({
      accepted: true,
      eventId: "event-telegram-1",
      orgId: "org-1",
      source,
      eventType,
    });
    expect(issueIdentityClaimMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        linkSource: "telegram",
        externalActorId: "chat-1",
        publicBaseUrl: "https://example.com",
      }),
    );
    expect(replyCalls).toEqual(["claim:https://example.com/claims/chat-1"]);

    const otpResult = await ingestEvent({
      id: "event-otp-1",
      orgId: "org-1",
      source: "otp",
      eventType: "identity.claim.completed",
      payload: {
        linkSource: "telegram",
        externalActorId: "chat-1",
      },
      actor: null,
      subject: {
        userId: "user-1",
      },
    });

    expect(otpResult).toEqual({
      accepted: true,
      eventId: "event-otp-1",
      orgId: "org-1",
      source: "otp",
      eventType: "identity.claim.completed",
    });

    const secondTelegramResult = await ingestEvent({
      id: "event-telegram-2",
      orgId: "org-1",
      payload: { text: "/start again" },
      actor: {
        type: "external",
        externalId: "chat-1",
      },
    });

    expect(secondTelegramResult).toEqual({
      accepted: true,
      eventId: "event-telegram-2",
      orgId: "org-1",
      source,
      eventType,
    });
    expect(issueIdentityClaimMock).toHaveBeenCalledTimes(1);
    expect(replyCalls).toEqual([
      "claim:https://example.com/claims/chat-1",
      "already-linked:user-1",
    ]);
  });

  test("ignores revoked identity bindings when looking up an existing actor", async () => {
    const telegramScriptId = await createScript({
      key: "telegram-linking-after-revoke",
      script: [
        'linked_user="$(automations.identity.lookup-binding --source "$AUTOMATION_SOURCE" --external-actor-id "$AUTOMATION_EXTERNAL_ACTOR_ID" --print user-id || true)"',
        'if [ -n "$linked_user" ]; then',
        '  event.reply --text "already-linked:$linked_user"',
        "else",
        '  claim_url="$(otp.identity.create-claim --source "$AUTOMATION_SOURCE" --external-actor-id "$AUTOMATION_EXTERNAL_ACTOR_ID" --print url)"',
        '  event.reply --text "claim:$claim_url"',
        "fi",
      ].join("\n"),
    });

    await createBinding({ scriptId: telegramScriptId, enabled: true });

    await testContext.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(automationFragmentSchema).create("identity_binding", {
            source: "telegram",
            externalActorId: "chat-1",
            userId: "user-1",
            status: "revoked",
          });
        })
        .execute();
    });

    const result = await ingestEvent({
      id: "event-telegram-revoked-1",
      orgId: "org-1",
      payload: { text: "/start" },
      actor: {
        type: "external",
        externalId: "chat-1",
      },
    });

    expect(result).toEqual({
      accepted: true,
      eventId: "event-telegram-revoked-1",
      orgId: "org-1",
      source,
      eventType,
    });
    expect(issueIdentityClaimMock).toHaveBeenCalledTimes(1);
    expect(issueIdentityClaimMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        linkSource: "telegram",
        externalActorId: "chat-1",
        publicBaseUrl: "https://example.com",
      }),
    );
    expect(replyCalls).toEqual(["claim:https://example.com/claims/chat-1"]);
  });

  test("built-in telegram /pi message creates a Pi session when Pi automation context is available", async () => {
    const createPiAutomationContext = vi.fn(() => ({
      runtime: {
        createSession: createPiSessionMock,
        getSession: vi.fn(async () => {
          throw new Error("unused in test");
        }),
        listSessions: vi.fn(async () => {
          throw new Error("unused in test");
        }),
      } satisfies PiBashRuntime,
      bashEnv: {
        AUTOMATION_PI_DEFAULT_AGENT: "default::openai::gpt-5-mini",
      },
    }));

    const builtInContext = await buildAutomationTestContext({
      builtinScripts: builtinAutomationScripts,
      builtinBindings: builtinAutomationBindings,
      createPiAutomationContext,
    });

    try {
      const builtInFragment = builtInContext.fragments.automation;

      const result = await builtInFragment.fragment.callServices(() =>
        builtInFragment.services.ingestEvent({
          id: "built-in-telegram-pi-1",
          orgId: "org-1",
          source: "telegram",
          eventType: "message.received",
          occurredAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          payload: {
            text: "/pi",
            chatId: "chat-1",
          },
          actor: {
            type: "external",
            externalId: "chat-1",
          },
        }),
      );

      await drainDurableHooks(builtInFragment.fragment);

      expect(result).toEqual({
        accepted: true,
        eventId: "built-in-telegram-pi-1",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
      });
      expect(createPiAutomationContext).toHaveBeenCalledWith({
        event: expect.objectContaining({
          id: "built-in-telegram-pi-1",
          orgId: "org-1",
          source: "telegram",
          eventType: "message.received",
        }),
        idempotencyKey: expect.any(String),
      });
      expect(createPiSessionMock).toHaveBeenCalledWith({
        agent: "default::openai::gpt-5-mini",
        name: "Telegram chat-1",
        tags: ["telegram", "auto-session"],
      });
      expect(replyCalls).toEqual(["Created Pi session: session-for-default::openai::gpt-5-mini"]);
    } finally {
      await builtInContext.test.cleanup();
    }
  });

  test("built-in telegram claim linking start fails loudly when identity claim issuance is not configured", async () => {
    const builtInContext = await buildAutomationTestContext({
      env: {
        OTP: automationEnv.OTP,
      } as unknown as CloudflareEnv,
      builtinScripts: builtinAutomationScripts,
      builtinBindings: builtinAutomationBindings,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const builtInFragment = builtInContext.fragments.automation;

      const result = await builtInFragment.fragment.callServices(() =>
        builtInFragment.services.ingestEvent({
          id: "built-in-telegram-missing-base-url-1",
          orgId: "org-1",
          source: "telegram",
          eventType: "message.received",
          occurredAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          payload: {
            text: "/start",
            chatId: "chat-1",
          },
          actor: {
            type: "external",
            externalId: "chat-1",
          },
        }),
      );

      expect(result).toEqual({
        accepted: true,
        eventId: "built-in-telegram-missing-base-url-1",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
      });
      await drainDurableHooks(builtInFragment.fragment);
      expect(errorSpy).toHaveBeenCalledWith(
        "[fragno-db] Hook failed",
        expect.objectContaining({
          namespace: "automations",
          hookName: "internalIngestEvent",
          error: expect.stringContaining(
            "DOCS_PUBLIC_BASE_URL must be configured before issuing automation identity claims.",
          ),
        }),
      );
      expect(issueIdentityClaimMock).not.toHaveBeenCalled();
      expect(replyCalls).toEqual([]);
    } finally {
      errorSpy.mockRestore();
      await builtInContext.test.cleanup();
    }
  });

  test("built-in telegram claim linking completion replies with a failure message when linking fails", async () => {
    const builtInContext = await buildAutomationTestContext({
      builtinScripts: builtinAutomationScripts,
      builtinBindings: builtinAutomationBindings,
    });

    try {
      const builtInFragment = builtInContext.fragments.automation;

      const ingestBuiltInEvent = async (overrides: Partial<AutomationEvent> = {}) => {
        const result = await builtInFragment.fragment.callServices(() =>
          builtInFragment.services.ingestEvent({
            id: "event-123",
            source: "telegram",
            eventType: "message.received",
            occurredAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
            payload: {},
            actor: {
              type: "external",
              externalId: "chat-1",
            },
            ...overrides,
          }),
        );

        await drainDurableHooks(builtInFragment.fragment);
        return result;
      };

      await ingestBuiltInEvent({
        id: "built-in-telegram-failure-1",
        orgId: "org-1",
        payload: {
          text: "/start",
          chatId: "chat-1",
        },
      });

      const otpResult = await ingestBuiltInEvent({
        id: "built-in-otp-failure-1",
        orgId: "org-1",
        source: "otp",
        eventType: "identity.claim.completed",
        payload: {
          linkSource: "telegram",
          externalActorId: "chat-1",
        },
        actor: null,
        subject: null,
      });

      expect(otpResult).toEqual({
        accepted: true,
        eventId: "built-in-otp-failure-1",
        orgId: "org-1",
        source: "otp",
        eventType: "identity.claim.completed",
      });
      expect(replyCalls).toEqual([
        "Open this link to finish linking your Telegram account: https://example.com/claims/chat-1",
        "We couldn't link your Telegram chat. Please try again.",
      ]);

      const identityBindingsResponse = await builtInFragment.fragment.callRoute(
        "GET",
        "/identity-bindings",
      );

      expect(identityBindingsResponse.type).toBe("json");
      if (identityBindingsResponse.type === "json") {
        expect(identityBindingsResponse.data).toEqual([]);
      }
    } finally {
      await builtInContext.test.cleanup();
    }
  });

  test("prefers built-in telegram claim-linking bindings over stored bindings", async () => {
    const builtInContext = await buildAutomationTestContext({
      builtinScripts: builtinAutomationScripts,
      builtinBindings: builtinAutomationBindings,
    });

    try {
      const builtInFragment = builtInContext.fragments.automation;

      const createBuiltInScript = async ({ key, script }: { key: string; script: string }) => {
        const response = await builtInFragment.fragment.callRoute("POST", "/scripts", {
          body: {
            key,
            name: key,
            engine: "bash",
            script,
            version: 1,
            enabled: true,
          },
        });

        if (response.type !== "json") {
          throw new Error("Expected JSON response when creating script");
        }

        return response.data.id;
      };

      const createBuiltInBinding = async ({
        source,
        eventType,
        scriptId,
      }: {
        source: string;
        eventType: string;
        scriptId: string;
      }) => {
        const response = await builtInFragment.fragment.callRoute("POST", "/bindings", {
          body: {
            source,
            eventType,
            scriptId,
            enabled: true,
          },
        });

        if (response.type !== "json") {
          throw new Error("Expected JSON response when creating binding");
        }
      };

      const ingestBuiltInEvent = async (overrides: Partial<AutomationEvent> = {}) => {
        const result = await builtInFragment.fragment.callServices(() =>
          builtInFragment.services.ingestEvent({
            id: "event-123",
            source: "telegram",
            eventType: "message.received",
            occurredAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
            payload: {},
            actor: {
              type: "external",
              externalId: "chat-1",
            },
            ...overrides,
          }),
        );

        await drainDurableHooks(builtInFragment.fragment);
        return result;
      };

      const storedTelegramScriptId = await createBuiltInScript({
        key: "stored-telegram-script",
        script: 'event.reply --text "stored-telegram-binding-ran"',
      });
      const storedOtpScriptId = await createBuiltInScript({
        key: "stored-otp-script",
        script: 'event.reply --text "stored-otp-binding-ran"',
      });

      await createBuiltInBinding({
        source: "telegram",
        eventType: "message.received",
        scriptId: storedTelegramScriptId,
      });
      await createBuiltInBinding({
        source: "otp",
        eventType: "identity.claim.completed",
        scriptId: storedOtpScriptId,
      });

      const firstTelegramResult = await ingestBuiltInEvent({
        id: "built-in-telegram-1",
        orgId: "org-1",
        payload: {
          text: "/start",
          chatId: "chat-1",
        },
      });

      expect(firstTelegramResult).toEqual({
        accepted: true,
        eventId: "built-in-telegram-1",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
      });
      expect(issueIdentityClaimMock).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: "org-1",
          linkSource: "telegram",
          externalActorId: "chat-1",
          publicBaseUrl: "https://example.com",
        }),
      );
      expect(replyCalls).toEqual([
        "Open this link to finish linking your Telegram account: https://example.com/claims/chat-1",
      ]);

      const otpResult = await ingestBuiltInEvent({
        id: "built-in-otp-1",
        orgId: "org-1",
        source: "otp",
        eventType: "identity.claim.completed",
        payload: {
          linkSource: "telegram",
          externalActorId: "chat-1",
        },
        actor: null,
        subject: {
          userId: "user-1",
        },
      });

      expect(otpResult).toEqual({
        accepted: true,
        eventId: "built-in-otp-1",
        orgId: "org-1",
        source: "otp",
        eventType: "identity.claim.completed",
      });
      expect(replyCalls).toEqual([
        "Open this link to finish linking your Telegram account: https://example.com/claims/chat-1",
        "Your Telegram chat is now linked.",
      ]);

      const secondTelegramResult = await ingestBuiltInEvent({
        id: "built-in-telegram-2",
        orgId: "org-1",
        payload: {
          text: "/start",
          chatId: "chat-1",
        },
      });

      expect(secondTelegramResult).toEqual({
        accepted: true,
        eventId: "built-in-telegram-2",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
      });
      expect(issueIdentityClaimMock).toHaveBeenCalledTimes(1);
      expect(replyCalls).toEqual([
        "Open this link to finish linking your Telegram account: https://example.com/claims/chat-1",
        "Your Telegram chat is now linked.",
        "This Telegram chat is already linked.",
      ]);
      expect(replyCalls).not.toContain("stored-telegram-binding-ran");
      expect(replyCalls).not.toContain("stored-otp-binding-ran");
    } finally {
      await builtInContext.test.cleanup();
    }
  });
});
