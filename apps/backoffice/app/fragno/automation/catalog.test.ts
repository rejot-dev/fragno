import { describe, expect, test } from "vitest";

import { createMasterFileSystem, type FilesContext } from "@/files";
import {
  UPLOAD_PROVIDER_R2,
  UPLOAD_PROVIDER_R2_BINDING,
  type UploadAdminConfigResponse,
} from "@/fragno/upload";
import type { UploadFileRecord } from "@/routes/backoffice/connections/upload/data";

import {
  AUTOMATION_WORKSPACE_ROOT,
  getAutomationBindingsForEvent,
  listAutomationWorkspaceScripts,
  loadAutomationCatalog,
  readAutomationWorkspaceScript,
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

const withFileSystemOverrides = <T extends object>(fileSystem: T, overrides: Partial<T>): T =>
  Object.assign(Object.create(fileSystem), overrides);

describe("automation catalog", () => {
  test("loads starter automation scripts from /workspace", async () => {
    const fileSystem = await createAutomationFileSystem();
    const catalog = await loadAutomationCatalog(fileSystem);

    expect(catalog.bindings.length).toBeGreaterThan(0);
    expect(catalog.scripts.length).toBeGreaterThan(0);
    expect(catalog.bindings.every((binding) => binding.scriptBody.trim().length > 0)).toBe(true);

    const telegramBindings = getAutomationBindingsForEvent(catalog, {
      source: AUTOMATION_SOURCES.telegram,
      eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
    });
    expect(telegramBindings.length).toBeGreaterThan(0);
    expect(telegramBindings.every((binding) => binding.scriptEngine === "codemode")).toBe(true);
  });

  test("lists workspace scripts", async () => {
    const fileSystem = await createAutomationFileSystem({
      "automations/scripts/unbound-codemode.cm.js": "async () => true",
      "automations/scripts/unbound-workspace-script.sh": 'echo "hello from workspace"',
    });

    const scripts = await listAutomationWorkspaceScripts(fileSystem);

    expect(scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "scripts/unbound-codemode.cm.js",
          absolutePath: `${AUTOMATION_WORKSPACE_ROOT}/scripts/unbound-codemode.cm.js`,
          engine: "codemode",
        }),
        expect.objectContaining({
          path: "scripts/unbound-workspace-script.sh",
          absolutePath: `${AUTOMATION_WORKSPACE_ROOT}/scripts/unbound-workspace-script.sh`,
          engine: "bash",
        }),
      ]),
    );
  });

  test("treats a missing workspace scripts directory as empty", async () => {
    const fileSystem = withFileSystemOverrides(await createAutomationFileSystem(), {
      async readdirWithFileTypes() {
        throw new Error("Path not found.");
      },
    });

    await expect(listAutomationWorkspaceScripts(fileSystem)).resolves.toEqual([]);
  });

  test("rethrows non-missing workspace directory errors from readdirWithFileTypes", async () => {
    const fileSystem = withFileSystemOverrides(await createAutomationFileSystem(), {
      async readdirWithFileTypes() {
        throw Object.assign(new Error("Permission denied."), { code: "EACCES" });
      },
    });

    await expect(listAutomationWorkspaceScripts(fileSystem)).rejects.toThrow("Permission denied.");
  });

  test("rethrows non-missing workspace directory errors from readdir fallback", async () => {
    const fileSystem = withFileSystemOverrides(await createAutomationFileSystem(), {
      readdirWithFileTypes: undefined,
      async readdir() {
        throw Object.assign(new Error("I/O failure."), { code: "EIO" });
      },
    });

    await expect(listAutomationWorkspaceScripts(fileSystem)).rejects.toThrow("I/O failure.");
  });

  test("reads an individual workspace script only when requested", async () => {
    const fileSystem = await createAutomationFileSystem({
      "automations/scripts/lazy-read.sh": 'echo "lazy"',
    });

    const script = await readAutomationWorkspaceScript(fileSystem, "scripts/lazy-read.sh");

    expect(script).toMatchObject({
      path: "scripts/lazy-read.sh",
      absolutePath: `${AUTOMATION_WORKSPACE_ROOT}/scripts/lazy-read.sh`,
      body: 'echo "lazy"',
    });
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
