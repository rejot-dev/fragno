import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import { env } from "cloudflare:workers";

import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";
import { workflowsFragmentDefinition, workflowsRoutesFactory } from "@fragno-dev/workflows";

import { createMasterFileSystem, type FilesContext, type IFileSystem } from "@/files";
import {
  UPLOAD_PROVIDER_R2,
  UPLOAD_PROVIDER_R2_BINDING,
  type UploadAdminConfigResponse,
} from "@/fragno/upload";
import type { UploadFileRecord } from "@/routes/backoffice/connections/upload/data";

import type { AutomationEvent } from "./contracts";
import { automationFragmentDefinition, type AutomationPiBashContext } from "./definition";
import { defineAutomationCodemodeWorkflow } from "./engine/workflow";
import { automationFragmentRoutes } from "./routes";

const telegramSendCalls: Array<{ chatId: string; text: string }> = [];
const issueIdentityClaimMock = vi.fn(async ({ externalActorId }: { externalActorId: string }) => ({
  url: `https://example.com/claims/${externalActorId}`,
  otpId: "otp-1",
  externalId: externalActorId,
  code: "123456",
  type: "otp",
}));
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
      sendAutomationReply: vi.fn(),
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

      if (request.method === "DELETE" && url.pathname === "/api/upload/files/by-key") {
        const provider = url.searchParams.get("provider") ?? "";
        const key = url.searchParams.get("key") ?? "";
        const storageKey = composeStorageKey(provider, key);
        files.delete(storageKey);
        contents.delete(storageKey);
        return Response.json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/upload/files") {
        const form = await request.formData();
        const provider = form.get("provider")?.toString() ?? UPLOAD_PROVIDER_R2;
        const fileKey = form.get("fileKey")?.toString() ?? "";
        const filename = form.get("filename")?.toString() ?? fileKey.split("/").at(-1) ?? fileKey;
        const uploadedFile = form.get("file") as File | null;
        const bytes = uploadedFile
          ? new Uint8Array(await uploadedFile.arrayBuffer())
          : new Uint8Array(0);
        const contentType = uploadedFile?.type || guessContentType(fileKey);

        setFile(fileKey, { provider, content: bytes, contentType });
        const record = files.get(composeStorageKey(provider, fileKey));
        return Response.json(record ?? { provider, fileKey, filename, status: "ready" });
      }

      if (request.method === "PATCH" && url.pathname === "/api/upload/files/by-key") {
        const provider = url.searchParams.get("provider") ?? "";
        const key = url.searchParams.get("key") ?? "";
        const file = files.get(composeStorageKey(provider, key));
        if (!file) {
          return Response.json({ message: "File not found." }, { status: 404 });
        }
        return Response.json(file);
      }

      return new Response("Not Found", { status: 404 });
    },
  } satisfies NonNullable<FilesContext["uploadRuntime"]> & {
    uploadConfig: UploadAdminConfigResponse;
  };
};

const createAutomationFileSystem = async (
  overlay: Record<string, string> = {},
): Promise<IFileSystem> => {
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
      const routePath = url.pathname.replace(/^\/api\/automations\/bindings/, "") || "/";
      const body = request.method === "GET" ? undefined : await request.json();
      return await result.fragments.automation.fragment.callRouteRaw(
        request.method as never,
        routePath,
        {
          query: Object.fromEntries(url.searchParams),
          body,
        },
      );
    },
  })) as never;

  return result;
};

const { fragments, test: testContext } = await buildAutomationTestContext();

describe("automation internalIngestEvent", () => {
  const fragment = fragments.automation;
  const source = "telegram";
  const eventType = "message.received";

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
    await drainDurableHooks(fragments.workflows.fragment);
    return result;
  };

  beforeEach(async () => {
    telegramSendCalls.length = 0;
    vi.clearAllMocks();
    issueIdentityClaimMock.mockClear();
    createPiSessionMock.mockClear();
    await testContext.resetDatabase();
    await setAutomationOverlay();
  });

  afterAll(async () => {
    await testContext.cleanup();
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
      await setAutomationOverlay({
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
            type: "external",
            externalId: "chat-1",
          },
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

  test("prefers persistent overlay automation files over starter script contents", async () => {
    await setAutomationOverlay({
      "automations/router.js": `async () => {
  await telegram.sendMessage({ chatId: "chat-1", text: "overlay-start" });
};`,
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
    expect(telegramSendCalls).toEqual([{ chatId: "chat-1", text: "overlay-start" }]);
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
