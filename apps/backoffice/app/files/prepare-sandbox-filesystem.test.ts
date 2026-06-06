import { beforeEach, describe, expect, test, vi } from "vitest";

import { UPLOAD_PROVIDER_R2, type UploadAdminConfigResponse } from "@/fragno/upload";
import type { UploadFileRecord } from "@/routes/backoffice/connections/upload/data";
import type { MkdirOptions, SandboxHandle, WriteFileOptions } from "@/sandbox/contracts";

import { createMasterFileSystem } from "./master-file-system";
import {
  BOOTSTRAP_SENTINEL_PATH,
  hasBootstrapSentinel,
  prepareSandboxFileSystem,
  type ResolveUploadMount,
  writeArtifactToSandbox,
} from "./prepare-sandbox-filesystem";
import { resetFileContributorsForTest } from "./registry";
import type { FilesContext } from "./types";

const createMockHandle = (
  overrides: {
    exists?: (path: string) => Promise<{ exists: boolean }>;
    mkdir?: (path: string, options?: MkdirOptions) => Promise<void>;
    writeFile?: (path: string, content: string, options?: WriteFileOptions) => Promise<void>;
    mountBucket?: (
      bucket: string,
      mountPoint: string,
      options: { endpoint: string },
    ) => Promise<void>;
  } = {},
): SandboxHandle =>
  ({
    id: "",
    executeCommand: vi.fn(),
    mkdir: vi.fn(overrides.mkdir ?? (async () => undefined)),
    writeFile: vi.fn(overrides.writeFile ?? (async () => undefined)),
    exists: vi.fn(overrides.exists ?? (async () => ({ exists: false }))),
    mountBucket: vi.fn(overrides.mountBucket ?? (async () => undefined)),
  }) as unknown as SandboxHandle;

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
        bucket: "tenant-uploads",
        endpoint: "https://example.r2.cloudflarestorage.com",
      },
    },
  },
  ...overrides,
});

const createUploadRuntime = (
  seed: Record<string, string | Uint8Array> = {},
): NonNullable<FilesContext["uploadRuntime"]> & {
  uploadConfig: UploadAdminConfigResponse;
} => {
  const now = new Date("2026-03-18T12:00:00.000Z").toISOString();
  const files = new Map<string, UploadFileRecord>();
  const contents = new Map<string, Uint8Array>();

  const setFile = (fileKey: string, content: string | Uint8Array) => {
    const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
    contents.set(fileKey, bytes);
    files.set(fileKey, {
      provider: UPLOAD_PROVIDER_R2,
      fileKey,
      status: "ready",
      sizeBytes: bytes.byteLength,
      filename: fileKey.split("/").at(-1) ?? fileKey,
      contentType: guessContentType(fileKey),
      createdAt: now,
      updatedAt: now,
    });
  };

  for (const [fileKey, content] of Object.entries(seed)) {
    setFile(fileKey, content);
  }

  return {
    baseUrl: "https://sandbox.internal",
    uploadConfig: createUploadConfig(),
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/upload/files") {
        return Response.json({ files: Array.from(files.values()), hasNextPage: false });
      }

      if (request.method === "GET" && url.pathname === "/api/upload/files/by-key") {
        const key = url.searchParams.get("key") ?? "";
        const file = files.get(key);
        if (!file) {
          return Response.json({ message: "File not found." }, { status: 404 });
        }
        return Response.json(file);
      }

      if (request.method === "GET" && url.pathname === "/api/upload/files/by-key/content") {
        const key = url.searchParams.get("key") ?? "";
        const file = files.get(key);
        const content = contents.get(key);
        if (!file || !content) {
          return Response.json({ message: "File not found." }, { status: 404 });
        }

        return new Response(new Uint8Array(content), {
          status: 200,
          headers: {
            "content-type": file.contentType,
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  };
};

const createSandboxFileSystem = async (overrides: Partial<FilesContext> = {}) => {
  return createMasterFileSystem({
    orgId: "acme-org",
    backend: "sandbox",
    ...overrides,
  });
};

beforeEach(() => {
  resetFileContributorsForTest();
});

describe("prepareSandboxFileSystem", () => {
  test("returns early when the bootstrap sentinel already exists", async () => {
    const handle = createMockHandle({
      exists: async (path) => ({ exists: path === BOOTSTRAP_SENTINEL_PATH }),
    });
    const fileSystem = await createSandboxFileSystem();

    await prepareSandboxFileSystem({
      orgId: "acme-org",
      backend: "sandbox",
      fileSystem,
      handle,
    });

    expect(handle.mkdir).not.toHaveBeenCalled();
    expect(handle.writeFile).not.toHaveBeenCalled();
    expect(handle.mountBucket).not.toHaveBeenCalled();
  });

  test("mounts the persistent workspace bucket when the shared filesystem exposes a persistent workspace", async () => {
    const handle = createMockHandle();
    const uploadRuntime = createUploadRuntime();
    const fileSystem = await createSandboxFileSystem({
      origin: uploadRuntime.baseUrl,
      uploadConfig: uploadRuntime.uploadConfig,
      uploadRuntime,
    });
    const resolver: ResolveUploadMount = vi.fn(async (root) => {
      if (root.mountPoint !== "/workspace") {
        return null;
      }

      return {
        bucket: "tenant-uploads",
        options: { endpoint: "https://example.r2.cloudflarestorage.com" },
      };
    });

    await prepareSandboxFileSystem({
      orgId: "acme-org",
      backend: "sandbox",
      fileSystem,
      handle,
      resolveUploadMount: resolver,
    });

    expect(handle.mountBucket).toHaveBeenCalledWith("tenant-uploads", "/workspace", {
      endpoint: "https://example.r2.cloudflarestorage.com",
    });
  });

  test("throws if a persistent mount exists without a resolver", async () => {
    const handle = createMockHandle();
    const uploadRuntime = createUploadRuntime();
    const fileSystem = await createSandboxFileSystem({
      origin: uploadRuntime.baseUrl,
      uploadConfig: uploadRuntime.uploadConfig,
      uploadRuntime,
    });

    await expect(
      prepareSandboxFileSystem({
        orgId: "acme-org",
        backend: "sandbox",
        fileSystem,
        handle,
      }),
    ).rejects.toThrow("upload mount resolver");
  });

  test("throws if a persistent workspace mount exists but the resolver returns no bucket", async () => {
    const handle = createMockHandle();
    const uploadRuntime = createUploadRuntime();
    const fileSystem = await createSandboxFileSystem({
      origin: uploadRuntime.baseUrl,
      uploadConfig: uploadRuntime.uploadConfig,
      uploadRuntime,
    });
    const resolver: ResolveUploadMount = vi.fn(async () => null);

    await expect(
      prepareSandboxFileSystem({
        orgId: "acme-org",
        backend: "sandbox",
        fileSystem,
        handle,
        resolveUploadMount: resolver,
      }),
    ).rejects.toThrow("Upload mount configuration missing for '/workspace'.");
  });
});

describe("helpers", () => {
  test("hasBootstrapSentinel checks the sentinel path", async () => {
    const handle = createMockHandle({ exists: async () => ({ exists: true }) });
    await expect(hasBootstrapSentinel(handle)).resolves.toBe(true);
  });

  test("writeArtifactToSandbox writes strings as utf-8", async () => {
    const handle = createMockHandle();
    await writeArtifactToSandbox(handle, "/workspace/hello.txt", "hello");
    expect(handle.writeFile).toHaveBeenCalledWith("/workspace/hello.txt", "hello", {
      encoding: "utf-8",
    });
  });
});

const guessContentType = (fileKey: string): string => {
  if (/\.(md|mdx)$/i.test(fileKey)) {
    return "text/markdown";
  }
  if (/\.json$/i.test(fileKey)) {
    return "application/json";
  }
  return "text/plain";
};
