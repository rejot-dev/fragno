import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import { env } from "cloudflare:workers";

import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";
import { workflowsFragmentDefinition, workflowsRoutesFactory } from "@fragno-dev/workflows";

import {
  WORKSPACE_STARTER_CONTENT,
  STARTER_AUTOMATION_SCRIPT_PATHS,
  type IFileSystem,
} from "@/files";

import type { AutomationEvent } from "./contracts";
import { automationFragmentDefinition, type AutomationPiBashContext } from "./definition";
import { createTestMasterFileSystem } from "./engine/test-master-file-system.test-utils";
import { defineAutomationCodemodeWorkflow } from "./engine/workflow";
import { automationFragmentRoutes } from "./routes";

const telegramSendCalls: Array<{ chatId: string; text: string }> = [];
const issueIdentityClaimMock = vi.fn(
  async ({ actor }: { actor: { source?: string; id: string } }) => ({
    url: `https://example.com/claims/${actor.id}`,
    otpId: `otp-${actor.id}`,
    externalId: actor.id,
    code: "123456",
    actor,
    type: "otp",
  }),
);
const telegramGetFileMock = vi.fn(async ({ fileId }: { fileId: string }) => ({
  fileId,
  fileUniqueId: `unique-${fileId}`,
  filePath: `voice/${fileId}.ogg`,
  fileSize: 4,
}));
const telegramDownloadFileMock = vi.fn(async () => new Response(new Uint8Array([0, 255, 1, 2])));
const automationEnv = {
  LOADER: env.LOADER,
  DOCS_PUBLIC_BASE_URL: "https://example.com",
  OTP: {
    idFromName: vi.fn((orgId: string) => `otp:${orgId}`),
    get: vi.fn(() => ({
      issueIdentityClaim: issueIdentityClaimMock,
    })),
  },
  TELEGRAM: {
    idFromName: vi.fn((orgId: string) => `telegram:${orgId}`),
    get: vi.fn(() => ({
      fetch: vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        const pathname = url.pathname;

        if (request.method === "POST" && pathname.includes("/api/telegram/chats/")) {
          if (pathname.endsWith("/send")) {
            const chatId = pathname.split("/chats/")[1]!.split("/")[0]!;
            const body = (await request.json()) as { text?: string };
            telegramSendCalls.push({ chatId, text: body.text ?? "" });
            return new Response(JSON.stringify({ ok: true, queued: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          if (pathname.endsWith("/actions")) {
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          if (pathname.endsWith("/edit")) {
            return new Response(JSON.stringify({ ok: true, queued: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
        }

        return new Response(JSON.stringify({ message: "Not configured", code: "NOT_CONFIGURED" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }),
      getAutomationFile: telegramGetFileMock,
      downloadAutomationFile: telegramDownloadFileMock,
    })),
  },
  PI: {
    idFromName: vi.fn((orgId: string) => `pi:${orgId}`),
    get: vi.fn(() => ({
      getAdminConfig: vi.fn(async () => ({ configured: false })),
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "Not configured", code: "NOT_CONFIGURED" }), {
            status: 400,
          }),
      ),
    })),
  },
  RESEND: {
    idFromName: vi.fn((orgId: string) => `resend:${orgId}`),
    get: vi.fn(() => ({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "Not configured", code: "NOT_CONFIGURED" }), {
            status: 400,
          }),
      ),
    })),
  },
  RESON8: {
    idFromName: vi.fn((orgId: string) => `reson8:${orgId}`),
    get: vi.fn(() => ({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "Not configured", code: "NOT_CONFIGURED" }), {
            status: 400,
          }),
      ),
    })),
  },
  AUTOMATIONS: {
    idFromName: vi.fn((orgId: string) => `automations:${orgId}`),
    get: vi.fn(() => ({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "Not configured", code: "NOT_CONFIGURED" }), {
            status: 400,
          }),
      ),
    })),
  },
} as unknown as CloudflareEnv;
const createPiSessionMock = vi.fn(async ({ agent }: { agent: string }) => ({
  id: `session-for-${agent}`,
  name: null,
  status: "waiting" as const,
  agent,
  workflowName: "interactive-chat-workflow",
  steeringMode: "one-at-a-time" as const,
  metadata: null,
  tags: [],
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
}));
const createAutomationFileSystem = async (
  customFiles: Record<string, string> = {},
): Promise<IFileSystem> => {
  return createTestMasterFileSystem(
    Object.fromEntries([
      ["/workspace/.keep", ""],
      ...[...Object.entries(WORKSPACE_STARTER_CONTENT), ...Object.entries(customFiles)].map(
        ([path, content]) => [`/workspace/${path.replace(/^\/+/, "")}`, content],
      ),
    ]),
  );
};

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
  const testEnv = config.env ?? automationEnv;
  const workflowConfig = {
    env: testEnv,
    getAutomationFileSystem: async () => currentAutomationFileSystem,
  };
  const result = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "in-memory" })
    .withFragment(
      "workflows",
      instantiate(workflowsFragmentDefinition)
        .withConfig({
          workflows: {
            AUTOMATION_CODEMODE_SCRIPT: defineAutomationCodemodeWorkflow(workflowConfig),
          },
          runtime: defaultFragnoRuntime,
        })
        .withRoutes([workflowsRoutesFactory]),
    )
    .withFragmentFactory("automation", automationFragmentDefinition, ({ fragments }) =>
      instantiate(automationFragmentDefinition)
        .withConfig({
          env: testEnv,
          createPiAutomationContext: config.createPiAutomationContext,
          getAutomationFileSystem: async () => currentAutomationFileSystem,
        })
        .withServices({ workflows: fragments.workflows.services })
        .withRoutes([automationFragmentRoutes]),
    )
    .build();

  testEnv.AUTOMATIONS ??= {
    idFromName: (orgId: string) => `automations:${orgId}`,
    get: () => ({
      fetch: async () =>
        new Response(JSON.stringify({ message: "Not configured", code: "NOT_CONFIGURED" }), {
          status: 400,
        }),
    }),
  } as never;
  testEnv.AUTOMATIONS.get = (() => ({
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const body = request.method === "GET" ? undefined : await request.json();

      if (url.pathname.startsWith("/api/automations/bindings")) {
        const routePath = url.pathname.replace(/^\/api\/automations\/bindings/u, "") || "/";
        return await result.fragments.automation.fragment.callRouteRaw(
          request.method as never,
          routePath,
          {
            query: Object.fromEntries(url.searchParams),
            body,
          },
        );
      }

      if (url.pathname.startsWith("/api/automations")) {
        const segments = url.pathname.replace(/^\/api\/automations\/?/u, "").split("/");
        const [workflowName, instancesSegment, instanceId, suffix] = segments;

        if (request.method === "POST" && workflowName && instancesSegment === "instances") {
          if (!instanceId) {
            const response = await result.fragments.workflows.fragment.callRoute(
              "POST",
              "/:workflowName/instances",
              {
                pathParams: { workflowName },
                body: body as { id?: string; params?: unknown; remoteWorkflowName?: string },
              },
            );
            return Response.json(response.type === "json" ? response.data : response, {
              status: response.status ?? 200,
            });
          }

          if (suffix === "events") {
            const response = await result.fragments.workflows.fragment.callRoute(
              "POST",
              "/:workflowName/instances/:instanceId/events",
              {
                pathParams: { workflowName, instanceId },
                body: body as { type: string; payload?: unknown },
              },
            );
            return Response.json(response.type === "json" ? response.data : response, {
              status: response.status ?? 200,
            });
          }
        }
      }

      return Response.json({ message: "Not found", code: "NOT_FOUND" }, { status: 404 });
    },
  })) as never;

  return result;
};

const { fragments, test: testContext } = await buildAutomationTestContext();

describe("automation internalIngestEvent", () => {
  const fragment = fragments.automation;
  const source = "telegram";
  const eventType = "message.received";

  const setAutomationFiles = async (customFiles: Record<string, string> = {}) => {
    currentAutomationFileSystem = await createAutomationFileSystem(customFiles);
  };

  const ingestEvent = async (overrides: Partial<AutomationEvent> = {}) => {
    const defaultActor = {
      scope: "external" as const,
      source: "telegram",
      type: "user",
      id: "actor-1",
    };
    const actor = overrides.actor ?? defaultActor;
    const result = await fragment.fragment.callServices(() =>
      fragment.services.ingestEvent({
        id: "event-123",
        source,
        eventType,
        occurredAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        payload: {},
        ...overrides,
        actor,
        actors: overrides.actors ?? [actor],
      }),
    );

    await drainDurableHooks(fragment.fragment);
    await drainDurableHooks(fragments.workflows.fragment);
    return result;
  };

  beforeEach(async () => {
    telegramSendCalls.length = 0;
    vi.clearAllMocks();
    issueIdentityClaimMock.mockClear();
    createPiSessionMock.mockClear();
    await testContext.resetDatabase();
    await setAutomationFiles();
  });

  afterAll(async () => {
    await testContext.cleanup();
  });

  test("does not run the disabled starter Telegram Pi automation script", async () => {
    const runTurnMock = vi.fn(async ({ sessionId, text }: { sessionId: string; text: string }) => ({
      id: sessionId,
      name: "Telegram chat-1",
      status: "waiting" as const,
      agentName: "default::openai::gpt-5-mini",
      workflowName: "interactive-chat-workflow",
      agent: { state: { messages: [] }, events: [] },
      steeringMode: "one-at-a-time" as const,
      metadata: null,
      tags: ["telegram", "auto-session"],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      workflow: {
        status: "waiting" as const,
      },
      assistantText: `agent:${text}`,
      messageStatus: "active" as const,
      stream: [
        {
          type: "snapshot" as const,
          state: { messages: [] },
        },
      ],
      terminalState: { messages: [] },
    }));

    const createPiAutomationContext = vi.fn(() => ({
      runtime: {
        createSession: createPiSessionMock,
        getSession: vi.fn(async () => {
          throw new Error("unused in test");
        }),
        listSessions: vi.fn(async () => {
          throw new Error("unused in test");
        }),
        runTurn: runTurnMock,
      },
    }));

    const starterContext = await buildAutomationTestContext({
      createPiAutomationContext,
    });

    try {
      const starterFragment = starterContext.fragments.automation;
      currentAutomationFileSystem = await createAutomationFileSystem();

      const linkResponse = await starterFragment.fragment.callRoute("POST", "/store/set", {
        body: {
          key: "telegram/chat-1",
          value: "user-1",
          actor: { scope: "external", source: "telegram", type: "chat", id: "chat-1" },
        },
      });

      if (linkResponse.type !== "json") {
        throw new Error("Expected identity binding bind response");
      }

      const bootstrapResult = await starterFragment.fragment.callServices(() =>
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
            scope: "external",
            source: "telegram",
            type: "chat",
            id: "chat-1",
          },
          actors: [{ scope: "external", source: "telegram", type: "chat", id: "chat-1" }],
        }),
      );

      await drainDurableHooks(starterFragment.fragment);
      await drainDurableHooks(starterContext.fragments.workflows.fragment);

      const followUpResult = await starterFragment.fragment.callServices(() =>
        starterFragment.services.ingestEvent({
          id: "starter-telegram-pi-2",
          orgId: "org-1",
          source: "telegram",
          eventType: "message.received",
          occurredAt: new Date("2026-01-01T00:01:00.000Z").toISOString(),
          payload: {
            text: "Hello Pi",
            chatId: "chat-1",
          },
          actor: {
            scope: "external",
            source: "telegram",
            type: "chat",
            id: "chat-1",
          },
          actors: [{ scope: "external", source: "telegram", type: "chat", id: "chat-1" }],
        }),
      );

      await drainDurableHooks(starterFragment.fragment);
      await drainDurableHooks(starterContext.fragments.workflows.fragment);

      expect(bootstrapResult).toEqual({
        accepted: true,
        eventId: "starter-telegram-pi-1",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
      });
      expect(followUpResult).toEqual({
        accepted: true,
        eventId: "starter-telegram-pi-2",
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
      expect(createPiAutomationContext).toHaveBeenCalledWith({
        event: expect.objectContaining({
          id: "starter-telegram-pi-2",
          orgId: "org-1",
          source: "telegram",
          eventType: "message.received",
        }),
        idempotencyKey: expect.any(String),
      });
      expect(createPiSessionMock).not.toHaveBeenCalled();
      expect(runTurnMock).not.toHaveBeenCalled();
      expect(telegramSendCalls).toEqual([]);
    } finally {
      await starterContext.test.cleanup();
    }
  });

  test("lets Telegram-triggered scripts resolve attachment metadata and download binary bytes", async () => {
    telegramGetFileMock.mockImplementation(async ({ fileId }: { fileId: string }) => ({
      fileId,
      fileUniqueId: `unique-${fileId}`,
      filePath: "voice/attachment.ogg",
      fileSize: 4,
    }));
    telegramDownloadFileMock.mockImplementation(
      async () => new Response(new Uint8Array([0, 255, 1, 2])),
    );
    const telegramAttachmentContext = await buildAutomationTestContext();

    try {
      await setAutomationFiles({
        "automations/telegram-attachment-download.sh": `file_id="$(jq -r '.payload.attachments[0].fileId // ""' /context/event.json)"
if [ -z "$file_id" ]; then
  echo "Missing attachment fileId in /context/event.json" >&2
  exit 1
fi

telegram.file.get --file-id "$file_id" --print filePath > /workspace/telegram-file-path.txt
telegram.file.download --file-id "$file_id" > /workspace/telegram-download.bin
`,
      });

      const telegramAttachmentFragment = telegramAttachmentContext.fragments.automation;
      const result = await telegramAttachmentFragment.fragment.callServices(() =>
        telegramAttachmentFragment.services.ingestEvent({
          id: "telegram-attachment-event-1",
          orgId: "org-1",
          source: "telegram",
          eventType: "message.received",
          occurredAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          payload: {
            text: null,
            chatId: "chat-1",
            attachments: [
              {
                kind: "voice",
                fileId: "telegram-file-1",
              },
            ],
          },
          actor: {
            scope: "external",
            source: "telegram",
            type: "chat",
            id: "chat-1",
          },
          actors: [{ scope: "external", source: "telegram", type: "chat", id: "chat-1" }],
        }),
      );

      await drainDurableHooks(telegramAttachmentFragment.fragment);
      await drainDurableHooks(telegramAttachmentContext.fragments.workflows.fragment);

      expect(result).toEqual({
        accepted: true,
        eventId: "telegram-attachment-event-1",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
      });
      expect(telegramGetFileMock).toHaveBeenCalledWith({ fileId: "telegram-file-1" });
      expect(telegramDownloadFileMock).toHaveBeenCalledWith({ fileId: "telegram-file-1" });
    } finally {
      await telegramAttachmentContext.test.cleanup();
    }
  });

  test("runs custom static starter automation files in tests", async () => {
    await setAutomationFiles({
      [STARTER_AUTOMATION_SCRIPT_PATHS.workspaceRouter]: `async () => {
  await telegram.sendMessage({ chatId: "chat-1", text: "custom-start" });
};`,
    });

    const result = await ingestEvent({
      id: "custom-start-1",
      orgId: "org-1",
      payload: {
        text: "/start",
        chatId: "chat-1",
      },
      actor: {
        scope: "external",
        source: "telegram",
        type: "chat",
        id: "chat-1",
      },
    });

    expect(result).toEqual({
      accepted: true,
      eventId: "custom-start-1",
      orgId: "org-1",
      source: "telegram",
      eventType: "message.received",
    });
    expect(telegramSendCalls).toEqual([{ chatId: "chat-1", text: "custom-start" }]);
    expect(issueIdentityClaimMock).not.toHaveBeenCalled();
  });
});
