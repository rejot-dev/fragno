import {
  STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH,
  createMasterFileSystem,
  type FilesContext,
} from "@/files";
import {
  UPLOAD_PROVIDER_R2,
  UPLOAD_PROVIDER_R2_BINDING,
  type UploadAdminConfigResponse,
} from "@/fragno/upload";
import type { UploadFileRecord } from "@/routes/backoffice/connections/upload/data";

import {
  AUTOMATION_SOURCE_EVENT_TYPES,
  AUTOMATION_SOURCES,
  type AutomationEvent,
} from "./contracts";

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

export const createAutomationFileSystem = async (overlay: Record<string, string>) => {
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

export const buildManifest = (
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
        source: binding.source ?? AUTOMATION_SOURCES.telegram,
        eventType: binding.eventType ?? AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
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

export const createTelegramMessageEvent = (
  overrides: Partial<AutomationEvent> = {},
): AutomationEvent => ({
  id: "telegram-event-1",
  orgId: "org-1",
  source: AUTOMATION_SOURCES.telegram,
  eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: {
    text: "/start",
    chatId: "chat-1",
  },
  actor: {
    type: "external",
    externalId: "chat-1",
  },
  ...overrides,
});

export const createOtpClaimCompletedEvent = (
  overrides: Partial<AutomationEvent> = {},
): AutomationEvent => ({
  id: "otp-event-1",
  orgId: "org-1",
  source: AUTOMATION_SOURCES.otp,
  eventType: AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted,
  occurredAt: "2026-01-01T00:01:00.000Z",
  payload: {
    linkSource: "telegram",
    externalActorId: "chat-1",
  },
  actor: null,
  subject: {
    userId: "user-1",
  },
  ...overrides,
});

export { STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH };

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
