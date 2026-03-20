import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import { z } from "zod";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import {
  STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH,
  STARTER_AUTOMATION_SCRIPT_PATHS,
  createMasterFileSystem,
  type FilesContext,
  type IIFileSystem,
} from "@/files";
import {
  UPLOAD_PROVIDER_R2,
  UPLOAD_PROVIDER_R2_BINDING,
  type UploadAdminConfigResponse,
} from "@/fragno/upload";
import type { UploadFileRecord } from "@/routes/backoffice/connections/upload/data";

import type { PiBashRuntime } from "../pi-bash-runtime";
import type { AutomationEvent, AutomationSourceAdapterRegistry } from "./contracts";
import { automationFragmentDefinition, type AutomationPiBashContext } from "./definition";
import { automationFragmentRoutes } from "./routes";

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

const createUploadConfig = (
  overrides: Partial<UploadAdminConfigResponse> = {},
): UploadAdminConfigResponse => ({
  configured: true,
  defaultProvider: UPLOAD_PROVIDER_R2,
  providers: {
    [UPLOAD_PROVIDER_R2]: {
      provider: UPLOAD_PROVIDER_R2,
      configured: true,
      config: {
        bucket: "org-uploads",
        endpoint: "https://example.r2.cloudflarestorage.com",
        region: "auto",
      },
    },
    [UPLOAD_PROVIDER_R2_BINDING]: {
      provider: UPLOAD_PROVIDER_R2_BINDING,
      configured: false,
    },
  },
  ...overrides,
});

const createUploadRuntime = (
  seed: Record<string, { provider?: string; content: string | Uint8Array; contentType?: string }>,
) => {
  const now = new Date("2026-03-18T12:00:00.000Z").toISOString();
  const files = new Map<string, UploadFileRecord>();
  const contents = new Map<string, Uint8Array>();

  const setFile = (
    fileKey: string,
    input: { provider?: string; content: string | Uint8Array; contentType?: string },
  ) => {
    const provider = input.provider ?? UPLOAD_PROVIDER_R2;
    const bytes =
      input.content instanceof Uint8Array ? input.content : new TextEncoder().encode(input.content);
    contents.set(composeStorageKey(provider, fileKey), bytes);
    files.set(composeStorageKey(provider, fileKey), {
      provider,
      fileKey,
      status: "ready",
      sizeBytes: bytes.byteLength,
      filename: fileKey.split("/").at(-1) ?? fileKey,
      contentType: input.contentType ?? guessContentType(fileKey),
      createdAt: now,
      updatedAt: now,
    });
  };

  for (const [fileKey, input] of Object.entries(seed)) {
    setFile(fileKey, input);
  }

  return {
    baseUrl: "https://docs.example.test",
    uploadConfig: createUploadConfig(),
    async fetch(request: Request) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/upload/files") {
        return Response.json({ files: Array.from(files.values()), hasNextPage: false });
      }

      if (request.method === "GET" && url.pathname === "/api/upload/files/by-key") {
        const provider = url.searchParams.get("provider") ?? "";
        const key = url.searchParams.get("key") ?? "";
        const file = files.get(composeStorageKey(provider, key));
        if (!file) {
          return Response.json({ message: "File not found." }, { status: 404 });
        }
        return Response.json(file);
      }

      if (request.method === "GET" && url.pathname === "/api/upload/files/by-key/content") {
        const provider = url.searchParams.get("provider") ?? "";
        const key = url.searchParams.get("key") ?? "";
        const file = files.get(composeStorageKey(provider, key));
        const content = contents.get(composeStorageKey(provider, key));
        if (!file || !content) {
          return Response.json({ message: "File not found." }, { status: 404 });
        }

        return new Response(new Uint8Array(content), {
          status: 200,
          headers: { "content-type": file.contentType },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  } satisfies NonNullable<FilesContext["uploadRuntime"]> & {
    uploadConfig: UploadAdminConfigResponse;
  };
};

const createAutomationFileSystem = async (
  overlay: Record<string, string> = {},
): Promise<IIFileSystem> => {
  if (Object.keys(overlay).length === 0) {
    return createMasterFileSystem({
      orgId: "org_123",
      backend: "backoffice",
      uploadConfig: null,
    } satisfies FilesContext);
  }

  const uploadRuntime = createUploadRuntime(
    Object.fromEntries(Object.entries(overlay).map(([fileKey, content]) => [fileKey, { content }])),
  );

  return createMasterFileSystem({
    orgId: "org_123",
    backend: "backoffice",
    uploadConfig: uploadRuntime.uploadConfig,
    uploadRuntime,
  } satisfies FilesContext);
};

const buildManifest = (
  bindings: Array<{
    id: string;
    source?: string;
    eventType?: string;
    enabled?: boolean;
    triggerOrder?: number | null;
    script: {
      key: string;
      name: string;
      path: string;
      version?: number;
      agent?: string | null;
      env?: Record<string, string>;
    };
  }>,
) =>
  `${JSON.stringify(
    {
      version: 1,
      bindings: bindings.map((binding) => ({
        ...binding,
        script: {
          engine: "bash",
          version: 1,
          agent: null,
          env: {},
          ...binding.script,
        },
      })),
    },
    null,
    2,
  )}\n`;

let currentAutomationFileSystem = await createAutomationFileSystem();

const buildAutomationTestContext = async (
  config: {
    env?: CloudflareEnv;
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
          getAutomationFileSystem: async () => currentAutomationFileSystem,
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

  const setAutomationOverlay = async (overlay: Record<string, string> = {}) => {
    currentAutomationFileSystem = await createAutomationFileSystem(overlay);
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

  beforeEach(async () => {
    replyCalls.length = 0;
    vi.clearAllMocks();
    issueIdentityClaimMock.mockClear();
    createPiSessionMock.mockClear();
    await testContext.resetDatabase();
    await setAutomationOverlay();
  });

  afterAll(async () => {
    await testContext.cleanup();
  });

  test("warns and exits when no matching bindings exist", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await setAutomationOverlay({
        [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: buildManifest([]),
      });

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

  test("executes matching filesystem-backed bindings in trigger order and skips disabled bindings", async () => {
    await setAutomationOverlay({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: buildManifest([
        {
          id: "second",
          source,
          eventType,
          triggerOrder: 20,
          enabled: true,
          script: {
            key: "second",
            name: "Second",
            path: "scripts/second.sh",
          },
        },
        {
          id: "disabled",
          source,
          eventType,
          triggerOrder: 15,
          enabled: false,
          script: {
            key: "disabled",
            name: "Disabled",
            path: "scripts/disabled.sh",
          },
        },
        {
          id: "first",
          source,
          eventType,
          triggerOrder: 10,
          enabled: true,
          script: {
            key: "first",
            name: "First",
            path: "scripts/first.sh",
          },
        },
      ]),
      "automations/scripts/first.sh": 'event.reply --text "from-first"',
      "automations/scripts/second.sh": 'event.reply --text "from-second"',
      "automations/scripts/disabled.sh": 'event.reply --text "should-not-run"',
    });

    const result = await ingestEvent();

    expectAccepted(result);
    expect(replyCalls).toEqual(["from-first", "from-second"]);
  });

  test("stops executing later bindings after an earlier filesystem script failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await setAutomationOverlay({
        [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: buildManifest([
          {
            id: "failing",
            source,
            eventType,
            triggerOrder: 1,
            enabled: true,
            script: {
              key: "failing",
              name: "Failing",
              path: "scripts/failing.sh",
            },
          },
          {
            id: "skipped",
            source,
            eventType,
            triggerOrder: 2,
            enabled: true,
            script: {
              key: "skipped",
              name: "Skipped",
              path: "scripts/skipped.sh",
            },
          },
        ]),
        "automations/scripts/failing.sh": ['echo "boom" >&2', "exit 9"].join("\n"),
        "automations/scripts/skipped.sh": 'event.reply --text "should-not-run"',
      });

      const result = await ingestEvent();

      expectAccepted(result);
      expect(replyCalls).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        "[fragno-db] Hook failed",
        expect.objectContaining({
          namespace: "automations",
          hookName: "internalIngestEvent",
          error: expect.stringContaining(
            "Automation bash script script:failing@1:scripts/failing.sh failed for event event-123 with exit code 9.",
          ),
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("runs the starter Telegram linking flow from filesystem-backed automation files", async () => {
    const firstTelegramResult = await ingestEvent({
      id: "event-telegram-1",
      orgId: "org-1",
      payload: { text: "/start", chatId: "chat-1" },
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
    expect(replyCalls).toEqual([
      "Open this link to finish linking your Telegram account: https://example.com/claims/chat-1",
    ]);

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
      payload: { text: "/start", chatId: "chat-1" },
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
      "Open this link to finish linking your Telegram account: https://example.com/claims/chat-1",
      "Your Telegram chat is now linked.",
      "This Telegram chat is already linked.",
    ]);
  });

  test("uses the starter Telegram /pi automation script from the workspace filesystem", async () => {
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

    const starterContext = await buildAutomationTestContext({
      createPiAutomationContext,
    });

    try {
      const starterFragment = starterContext.fragments.automation;
      currentAutomationFileSystem = await createAutomationFileSystem();

      const result = await starterFragment.fragment.callServices(() =>
        starterFragment.services.ingestEvent({
          id: "starter-telegram-pi-1",
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

      await drainDurableHooks(starterFragment.fragment);

      expect(result).toEqual({
        accepted: true,
        eventId: "starter-telegram-pi-1",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
      });
      expect(createPiAutomationContext).toHaveBeenCalledWith({
        event: expect.objectContaining({
          id: "starter-telegram-pi-1",
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
      await starterContext.test.cleanup();
    }
  });

  test("fails loudly when the starter linking script cannot issue identity claims", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const noBaseUrlContext = await buildAutomationTestContext({
      env: {
        OTP: automationEnv.OTP,
      } as unknown as CloudflareEnv,
    });

    try {
      currentAutomationFileSystem = await createAutomationFileSystem();
      const noBaseUrlFragment = noBaseUrlContext.fragments.automation;

      const result = await noBaseUrlFragment.fragment.callServices(() =>
        noBaseUrlFragment.services.ingestEvent({
          id: "starter-telegram-missing-base-url-1",
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
        eventId: "starter-telegram-missing-base-url-1",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
      });
      await drainDurableHooks(noBaseUrlFragment.fragment);
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
      await noBaseUrlContext.test.cleanup();
    }
  });

  test("starter OTP completion script replies with a failure message when linking cannot complete", async () => {
    await ingestEvent({
      id: "starter-telegram-failure-1",
      orgId: "org-1",
      payload: {
        text: "/start",
        chatId: "chat-1",
      },
      actor: {
        type: "external",
        externalId: "chat-1",
      },
    });

    const otpResult = await ingestEvent({
      id: "starter-otp-failure-1",
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
      eventId: "starter-otp-failure-1",
      orgId: "org-1",
      source: "otp",
      eventType: "identity.claim.completed",
    });
    expect(replyCalls).toEqual([
      "Open this link to finish linking your Telegram account: https://example.com/claims/chat-1",
      "We couldn't link your Telegram chat. Please try again.",
    ]);

    const identityBindingsResponse = await fragment.fragment.callRoute("GET", "/identity-bindings");

    expect(identityBindingsResponse.type).toBe("json");
    if (identityBindingsResponse.type === "json") {
      expect(identityBindingsResponse.data).toEqual([]);
    }
  });

  test("prefers persistent overlay automation files over starter script contents", async () => {
    await setAutomationOverlay({
      [STARTER_AUTOMATION_SCRIPT_PATHS.telegramClaimLinkingStart]:
        'event.reply --text "overlay-start"',
    });

    const result = await ingestEvent({
      id: "overlay-start-1",
      orgId: "org-1",
      payload: {
        text: "/start",
        chatId: "chat-1",
      },
      actor: {
        type: "external",
        externalId: "chat-1",
      },
    });

    expect(result).toEqual({
      accepted: true,
      eventId: "overlay-start-1",
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
    });
    expect(replyCalls).toEqual(["overlay-start"]);
    expect(issueIdentityClaimMock).not.toHaveBeenCalled();
  });
});

const composeStorageKey = (provider: string, fileKey: string) => `${provider}::${fileKey}`;

const guessContentType = (fileKey: string): string => {
  if (/\.(md|mdx)$/i.test(fileKey)) {
    return "text/markdown";
  }
  if (/\.json$/i.test(fileKey)) {
    return "application/json";
  }
  if (/\.sh$/i.test(fileKey)) {
    return "text/x-shellscript";
  }
  return "text/plain";
};
