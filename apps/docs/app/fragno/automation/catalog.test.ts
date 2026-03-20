import { describe, expect, test } from "vitest";

import {
  STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH,
  STARTER_AUTOMATION_SCRIPT_PATHS,
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
  AUTOMATION_BINDINGS_MANIFEST_PATH,
  AUTOMATION_WORKSPACE_ROOT,
  getAutomationBindingsForEvent,
  loadAutomationCatalog,
} from "./catalog";
import { AUTOMATION_SOURCE_EVENT_TYPES, AUTOMATION_SOURCES } from "./contracts";

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
  useUploadOverlay = Object.keys(overlay).length > 0,
) => {
  if (!useUploadOverlay) {
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

describe("automation catalog", () => {
  test("loads the starter automation manifest and scripts from /workspace", async () => {
    const fileSystem = await createAutomationFileSystem();
    const catalog = await loadAutomationCatalog(fileSystem);

    expect(catalog.manifestPath).toBe(AUTOMATION_BINDINGS_MANIFEST_PATH);
    expect(catalog.bindings.map((binding) => binding.id)).toEqual([
      "telegram-claim-linking-complete",
      "telegram-claim-linking-start",
      "telegram-pi-session-start",
    ]);
    expect(catalog.scripts.map((script) => script.path)).toEqual(
      expect.arrayContaining([
        "scripts/telegram-claim-linking.complete.sh",
        "scripts/telegram-claim-linking.start.sh",
        "scripts/telegram-pi-session.start.sh",
      ]),
    );

    const telegramBindings = getAutomationBindingsForEvent(catalog, {
      source: AUTOMATION_SOURCES.telegram,
      eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
    });
    expect(telegramBindings.map((binding) => binding.id)).toEqual([
      "telegram-claim-linking-start",
      "telegram-pi-session-start",
    ]);
  });

  test("rejects malformed manifests with a clear error", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: "{not json}",
    });

    await expect(loadAutomationCatalog(fileSystem)).rejects.toThrow(
      `Automation manifest '${AUTOMATION_BINDINGS_MANIFEST_PATH}' is not valid JSON`,
    );
  });

  test("rejects missing script files referenced by the manifest", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: JSON.stringify(
        {
          version: 1,
          bindings: [
            {
              id: "missing-script",
              source: AUTOMATION_SOURCES.telegram,
              eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
              enabled: true,
              script: {
                key: "missing-script",
                name: "Missing script",
                engine: "bash",
                path: "scripts/missing.sh",
                version: 1,
                agent: null,
                env: {},
              },
            },
          ],
        },
        null,
        2,
      ),
    });

    await expect(loadAutomationCatalog(fileSystem)).rejects.toThrow(
      "Automation script for binding 'missing-script' '/workspace/automations/scripts/missing.sh' was not found",
    );
  });

  test("rejects script path traversal and non-scripts paths", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: JSON.stringify(
        {
          version: 1,
          bindings: [
            {
              id: "bad-path",
              source: AUTOMATION_SOURCES.telegram,
              eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
              enabled: true,
              script: {
                key: "bad-path",
                name: "Bad path",
                engine: "bash",
                path: "../escape.sh",
                version: 1,
                agent: null,
                env: {},
              },
            },
          ],
        },
        null,
        2,
      ),
      [STARTER_AUTOMATION_SCRIPT_PATHS.telegramClaimLinkingStart]: "echo should-not-load",
    });

    await expect(loadAutomationCatalog(fileSystem)).rejects.toThrow(
      "Automation binding 'bad-path' has invalid script path '../escape.sh'",
    );
  });

  test("derives a deduplicated scripts view from binding-local script metadata", async () => {
    const sharedScriptPath = "automations/scripts/shared.sh";
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: JSON.stringify(
        {
          version: 1,
          bindings: [
            {
              id: "binding-a",
              source: AUTOMATION_SOURCES.telegram,
              eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
              enabled: true,
              script: {
                key: "shared-script",
                name: "Shared script",
                engine: "bash",
                path: "scripts/shared.sh",
                version: 2,
                agent: null,
                env: { MODE: "one" },
              },
            },
            {
              id: "binding-b",
              source: AUTOMATION_SOURCES.otp,
              eventType: AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted,
              enabled: false,
              script: {
                key: "shared-script",
                name: "Shared script",
                engine: "bash",
                path: "scripts/shared.sh",
                version: 2,
                agent: null,
                env: { MODE: "one" },
              },
            },
          ],
        },
        null,
        2,
      ),
      [sharedScriptPath]: 'echo "shared"',
    });

    const catalog = await loadAutomationCatalog(fileSystem);

    expect(catalog.scripts).toHaveLength(1);
    expect(catalog.scripts[0]).toMatchObject({
      key: "shared-script",
      version: 2,
      bindingIds: ["binding-a", "binding-b"],
      bindingCount: 2,
      enabledBindingCount: 1,
      enabled: true,
    });
  });

  test("prefers persistent workspace overlay files over starter automation defaults", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: JSON.stringify(
        {
          version: 1,
          bindings: [
            {
              id: "overlay-only-binding",
              source: AUTOMATION_SOURCES.telegram,
              eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
              enabled: true,
              triggerOrder: 5,
              script: {
                key: "overlay-script",
                name: "Overlay script",
                engine: "bash",
                path: "scripts/overlay.sh",
                version: 3,
                agent: null,
                env: { MODE: "overlay" },
              },
            },
          ],
        },
        null,
        2,
      ),
      "automations/scripts/overlay.sh": 'echo "overlay"',
    });

    const catalog = await loadAutomationCatalog(fileSystem);

    expect(catalog.bindings).toHaveLength(1);
    expect(catalog.bindings[0]).toMatchObject({
      id: "overlay-only-binding",
      scriptKey: "overlay-script",
      scriptPath: "scripts/overlay.sh",
      scriptBody: 'echo "overlay"',
      scriptEnv: { MODE: "overlay" },
      triggerOrder: 5,
    });
    expect(catalog.scripts[0]?.absolutePath).toBe(
      `${AUTOMATION_WORKSPACE_ROOT}/scripts/overlay.sh`,
    );
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
