import { describe, expect, test } from "vitest";

import { Bash, defineCommand } from "just-bash";

import {
  createUploadFileSystem,
  getBuiltInFileContributors,
  resolveUploadFileMount,
  uploadFileContributor,
  type FilesContext,
} from "@/files";
import { toUploadDirectoryMarkerFileKey } from "@/files/contributors/upload-markers";
import {
  UPLOAD_PROVIDER_DATABASE,
  UPLOAD_PROVIDER_R2,
  UPLOAD_PROVIDER_R2_BINDING,
  type UploadAdminConfigResponse,
} from "@/fragno/upload";
import type { UploadFileRecord } from "@/routes/backoffice/connections/upload/data";

const createUploadConfig = (
  overrides: Partial<UploadAdminConfigResponse> = {},
): UploadAdminConfigResponse => ({
  configured: true,
  defaultProvider: UPLOAD_PROVIDER_DATABASE,
  providers: {
    [UPLOAD_PROVIDER_DATABASE]: {
      provider: UPLOAD_PROVIDER_DATABASE,
      configured: true,
      config: {},
    },
    [UPLOAD_PROVIDER_R2]: {
      provider: UPLOAD_PROVIDER_R2,
      configured: true,
      config: {
        bucket: "org-uploads",
        endpoint: "https://example.r2.cloudflarestorage.com",
        pathStyle: false,
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

describe("upload file contributor", () => {
  test("omits the workspace mount when upload is not configured", () => {
    expect(resolveUploadFileMount(null)).toBeNull();
    expect(
      resolveUploadFileMount({
        configured: false,
        defaultProvider: null,
        providers: {},
      }),
    ).toBeNull();
  });

  test("builds workspace mount metadata for configured org storage", () => {
    const mount = resolveUploadFileMount(
      createUploadConfig({
        defaultProvider: UPLOAD_PROVIDER_DATABASE,
        providers: {
          [UPLOAD_PROVIDER_DATABASE]: {
            provider: UPLOAD_PROVIDER_DATABASE,
            configured: true,
            config: {},
          },
          [UPLOAD_PROVIDER_R2]: {
            provider: UPLOAD_PROVIDER_R2,
            configured: true,
            config: {
              bucket: "org-uploads",
              endpoint: "https://example.r2.cloudflarestorage.com",
            },
          },
          [UPLOAD_PROVIDER_R2_BINDING]: {
            provider: UPLOAD_PROVIDER_R2_BINDING,
            configured: true,
            config: {
              bindingName: "UPLOAD_BUCKET",
            },
          },
        },
      }),
    );

    expect(mount).toMatchObject({
      id: "workspace",
      kind: "upload",
      mountPoint: "/workspace",
      title: "Workspace",
      readOnly: false,
      persistence: "persistent",
      uploadProvider: UPLOAD_PROVIDER_DATABASE,
    });
    expect(mount?.description).toContain("Database");
    expect(mount?.description).toContain("Configured providers");
  });

  test("exposes built-in contributors in deterministic order", () => {
    expect(getBuiltInFileContributors().map((contributor) => contributor.id)).toEqual([
      "system",
      "static-starter",
      "workspace",
      "r2",
      "r2-remote",
      "tmp",
      "resend",
      "durable-hooks-automation",
    ]);
  });

  test("lists, stats, and reads upload-backed files through the mounted filesystem contract", async () => {
    const { fs, runtime } = createUploadFs({
      "images/logo.png": { content: new Uint8Array([137, 80, 78, 71]) },
      "reports/config": {
        content: '{"ok":true}',
        contentType: "application/json; charset=utf-8",
      },
      "reports/q1.txt": { content: "ready" },
      "reports/q2.json": { content: '{"ok":true}' },
    });

    await expect(fs.readdir?.("/workspace")).resolves.toEqual(["images", "reports"]);
    await expect(fs.readdirWithFileTypes?.("/workspace/reports/")).resolves.toEqual([
      {
        name: "config",
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      },
      {
        name: "q1.txt",
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      },
      {
        name: "q2.json",
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      },
    ]);

    await expect(fs.exists?.("/workspace/reports/q1.txt")).resolves.toBe(true);
    await expect(fs.stat?.("/workspace/reports/q1.txt")).resolves.toMatchObject({
      isFile: true,
      isDirectory: false,
      mode: 0o644,
      size: 5,
    });

    await expect(fs.readFile?.("/workspace/reports/config")).resolves.toBe('{"ok":true}');
    await expect(fs.readFile?.("/workspace/reports/q1.txt")).resolves.toBe("ready");
    await expect(fs.readFileBuffer?.("/workspace/images/logo.png")).resolves.toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
    await expect(fs.readFile?.("/workspace/images/logo.png")).rejects.toThrow(
      /Binary files cannot be read as text/,
    );
    expect(runtime.requests).toContain(
      "GET /api/upload/files/by-key/content?provider=database&key=reports%2Fq1.txt",
    );
    expect(runtime.requests).toContain(
      "GET /api/upload/files/by-key/content?provider=database&key=images%2Flogo.png",
    );
    expect(runtime.requests).not.toContain(
      "GET /api/upload/files/by-key?provider=database&key=images%2Flogo.png",
    );
  });

  test("streams upload-backed file content through the mounted filesystem contract", async () => {
    const { fs, runtime } = createUploadFs({
      "reports/q1.txt": { content: "ready" },
    });

    if (!fs.readFileStream) {
      throw new Error("Expected upload filesystem to support read streams.");
    }

    const stream = await fs.readFileStream("/workspace/reports/q1.txt");
    await expect(readStream(stream)).resolves.toBe("ready");
    expect(runtime.requests).toContain(
      "GET /api/upload/files/by-key/content?provider=database&key=reports%2Fq1.txt",
    );
    expect(runtime.requests).not.toContain(
      "GET /api/upload/files/by-key?provider=database&key=reports%2Fq1.txt",
    );
  });

  test("can mount the upload-backed filesystem at a custom mount point", async () => {
    const { context } = createUploadFs({
      "README.md": { content: "custom readme" },
    });
    const fs = createUploadFileSystem(context, {
      mountPoint: "/scratch",
    });

    await expect(fs.readdir?.("/scratch")).resolves.toEqual(["README.md"]);
    await expect(fs.readFile?.("/scratch/README.md")).resolves.toBe("custom readme");

    await fs.writeFile?.("/scratch/output/generated.txt", "hello");
    await expect(fs.readFile?.("/scratch/output/generated.txt")).resolves.toBe("hello");
  });

  test("treats shell scripts with octet-stream content types as text files", async () => {
    const { fs } = createUploadFs({
      "scripts/telegram-file-store.sh": {
        content: 'echo "hello"',
        contentType: "application/octet-stream",
      },
    });

    await expect(fs.readFile?.("/workspace/scripts/telegram-file-store.sh")).resolves.toBe(
      'echo "hello"',
    );
    await expect(fs.stat("/workspace/scripts/telegram-file-store.sh")).resolves.toMatchObject({
      isFile: true,
    });
  });

  test("binds each mounted upload filesystem to a single provider", async () => {
    const uploadConfig = createUploadConfig({
      defaultProvider: UPLOAD_PROVIDER_R2,
      providers: {
        [UPLOAD_PROVIDER_R2]: {
          provider: UPLOAD_PROVIDER_R2,
          configured: true,
          config: {
            bucket: "org-uploads",
            endpoint: "https://example.r2.cloudflarestorage.com",
          },
        },
        [UPLOAD_PROVIDER_R2_BINDING]: {
          provider: UPLOAD_PROVIDER_R2_BINDING,
          configured: true,
          config: {
            bindingName: "UPLOAD_BUCKET",
          },
        },
      },
    });
    const runtime = createUploadRuntime(
      {
        "reports/credentials.txt": {
          provider: UPLOAD_PROVIDER_R2,
          content: "r2",
        },
        "reports/binding.txt": {
          provider: UPLOAD_PROVIDER_R2_BINDING,
          content: "binding",
        },
      },
      uploadConfig,
    );
    const context = {
      orgId: "acme-org",
      origin: runtime.baseUrl,
      backend: "pi" as const,
      uploadConfig,
      uploadRuntime: runtime,
      request: new Request("https://docs.example.test/backoffice/files"),
    } satisfies FilesContext;
    const fs = createUploadFileSystem(context, {
      provider: UPLOAD_PROVIDER_R2_BINDING,
    });

    await expect(fs.readdir?.("/workspace/reports")).resolves.toEqual(["binding.txt"]);
    await expect(fs.exists?.("/workspace/reports/binding.txt")).resolves.toBe(true);
    await expect(fs.exists?.("/workspace/reports/credentials.txt")).resolves.toBe(false);
  });

  test("avoids provider-discovery scans for single-file operations", async () => {
    const runtime = createUploadRuntime({
      "reports/q1.txt": { provider: UPLOAD_PROVIDER_R2, content: "ready" },
    });
    const context = {
      orgId: "acme-org",
      origin: runtime.baseUrl,
      backend: "pi" as const,
      uploadConfig: runtime.uploadConfig,
      uploadRuntime: runtime,
      request: new Request("https://docs.example.test/backoffice/files"),
    } satisfies FilesContext;
    const fs = createUploadFileSystem(context, {
      provider: UPLOAD_PROVIDER_R2,
    });

    runtime.requests.length = 0;

    await expect(fs.readFile?.("/workspace/reports/q1.txt")).resolves.toBe("ready");
    await fs.writeFile?.("/workspace/reports/q1.txt", "updated");
    await fs.rm?.("/workspace/reports/q1.txt", { force: true });

    expect(runtime.requests.some((request) => request.startsWith("GET /api/upload/files?"))).toBe(
      false,
    );
  });

  test("fails fast when a mount is bound to an unconfigured provider", () => {
    const runtime = createUploadRuntime({});
    const context = {
      orgId: "acme-org",
      origin: runtime.baseUrl,
      backend: "pi" as const,
      uploadConfig: runtime.uploadConfig,
      uploadRuntime: runtime,
    } satisfies FilesContext;

    expect(() =>
      createUploadFileSystem(context, {
        provider: UPLOAD_PROVIDER_R2_BINDING,
      }),
    ).toThrow("Upload provider 'r2-binding' is not configured.");
  });

  test("preserves binary stdout when bash redirection writes upload-backed files", async () => {
    const { fs } = createUploadFs({});
    const originalBytes = new Uint8Array([0, 255, 1, 2]);
    const binaryStdout = String.fromCharCode(...originalBytes);
    const bash = new Bash({
      fs,
      customCommands: [
        defineCommand("telegram.file.download", async () => ({
          stdout: binaryStdout,
          stdoutEncoding: "binary" as const,
          stderr: "",
          exitCode: 0,
        })),
      ],
    });

    const result = await bash.exec(
      "telegram.file.download --file-id telegram-file-1 > /workspace/audio.oga",
    );

    expect(result.exitCode).toBe(0);
    await expect(fs.readFileBuffer("/workspace/audio.oga")).resolves.toEqual(originalBytes);
  });

  test("writes and deletes upload-backed files through the mounted filesystem contract", async () => {
    const { fs, runtime } = createUploadFs({
      "reports/q1.txt": { content: "ready" },
    });

    await fs.writeFile?.("/workspace/reports/q1.txt", "updated");
    await expect(fs.readFile?.("/workspace/reports/q1.txt")).resolves.toBe("updated");

    await fs.writeFile?.("/workspace/notes/todo.md", "- ship it");
    expect(runtime.files.has(composeStorageKey(UPLOAD_PROVIDER_DATABASE, "notes/todo.md"))).toBe(
      true,
    );
    await expect(fs.readFile?.("/workspace/notes/todo.md")).resolves.toBe("- ship it");

    await fs.rm?.("/workspace/reports/", { recursive: true });
    await expect(fs.exists?.("/workspace/reports/q1.txt")).resolves.toBe(false);

    await fs.rm?.("/workspace", { recursive: true });
    await expect(fs.readdir?.("/workspace")).resolves.toEqual([]);
  });

  test("treats deleted upload records as missing for exact-path lookups", async () => {
    const { fs } = createUploadFs({
      "reports/q1.txt": {
        content: "stale",
        status: "deleted",
      },
    });

    await expect(fs.stat("/workspace/reports/q1.txt")).rejects.toThrow("ENOENT");
    await expect(fs.exists?.("/workspace/reports/q1.txt")).resolves.toBe(false);
    await expect(fs.stat?.("/workspace/reports/q1.txt")).rejects.toThrow("ENOENT");
    await expect(fs.readFile?.("/workspace/reports/q1.txt")).rejects.toThrow(
      "ENOENT: no such file or directory, read '/workspace/reports/q1.txt'",
    );
    await expect(fs.readdir?.("/workspace/reports")).resolves.toEqual([]);
  });

  test("stores cosmetic chmod and utimes metadata for upload-backed files and folders", async () => {
    const { fs, runtime } = createUploadFs({
      "reports/q1.txt": { content: "ready" },
    });

    const fileMtime = new Date("2020-01-02T03:04:05.000Z");
    await fs.chmod?.("/workspace/reports/q1.txt", 0o600);
    await fs.utimes?.("/workspace/reports/q1.txt", new Date(0), fileMtime);

    await fs.mkdir?.("/workspace/archive", { recursive: true });
    const folderMtime = new Date("2021-02-03T04:05:06.000Z");
    await fs.chmod?.("/workspace/archive", 0o700);
    await fs.utimes?.("/workspace/archive", new Date(0), folderMtime);

    await expect(fs.stat?.("/workspace/reports/q1.txt")).resolves.toMatchObject({
      mode: 0o600,
      mtime: fileMtime,
    });
    await expect(fs.stat?.("/workspace/archive/")).resolves.toMatchObject({
      mode: 0o700,
      mtime: folderMtime,
    });

    expect(
      runtime.files.get(composeStorageKey(UPLOAD_PROVIDER_DATABASE, "reports/q1.txt"))?.metadata,
    ).toMatchObject({
      __docsFs: {
        mode: 0o600,
        mtime: fileMtime.toISOString(),
      },
    });
    expect(
      runtime.files.get(
        composeStorageKey(UPLOAD_PROVIDER_DATABASE, toUploadDirectoryMarkerFileKey("archive")),
      )?.metadata,
    ).toMatchObject({
      __docsDirectoryMarker: true,
      __docsFs: {
        mode: 0o700,
        mtime: folderMtime.toISOString(),
      },
    });
  });

  test("preserves cosmetic mode while clearing custom mtime on overwrite", async () => {
    const { fs, runtime } = createUploadFs({
      "reports/q1.txt": { content: "ready" },
    });

    await fs.chmod?.("/workspace/reports/q1.txt", 0o600);
    await fs.utimes?.(
      "/workspace/reports/q1.txt",
      new Date(0),
      new Date("2020-01-02T03:04:05.000Z"),
    );

    await fs.writeFile?.("/workspace/reports/q1.txt", "updated");

    expect(
      runtime.files.get(composeStorageKey(UPLOAD_PROVIDER_DATABASE, "reports/q1.txt"))?.metadata,
    ).toMatchObject({
      __docsFs: {
        mode: 0o600,
      },
    });
    expect(
      runtime.files.get(composeStorageKey(UPLOAD_PROVIDER_DATABASE, "reports/q1.txt"))?.metadata,
    ).not.toMatchObject({
      __docsFs: {
        mtime: expect.any(String),
      },
    });
  });

  test("rejects chmod and utimes on the mounted upload root", async () => {
    const { fs } = createUploadFs({
      "reports/q1.txt": { content: "ready" },
    });

    await expect(fs.chmod?.("/workspace", 0o700)).rejects.toThrow(/operation not supported/i);
    await expect(fs.utimes?.("/workspace", new Date(0), new Date())).rejects.toThrow(
      /operation not supported/i,
    );
  });

  test("mkdir persists empty upload-backed folders and keeps them visible", async () => {
    const { fs, runtime } = createUploadFs({});

    await fs.mkdir?.("/workspace/reports/2026", { recursive: true });

    expect(
      runtime.files.has(
        composeStorageKey(UPLOAD_PROVIDER_DATABASE, toUploadDirectoryMarkerFileKey("reports")),
      ),
    ).toBe(true);
    expect(
      runtime.files.has(
        composeStorageKey(UPLOAD_PROVIDER_DATABASE, toUploadDirectoryMarkerFileKey("reports/2026")),
      ),
    ).toBe(true);

    await expect(fs.exists?.("/workspace/reports/")).resolves.toBe(true);
    await expect(fs.exists?.("/workspace/reports/2026/")).resolves.toBe(true);
    await expect(fs.stat?.("/workspace/reports/2026/")).resolves.toMatchObject({
      isDirectory: true,
      isFile: false,
    });
    await expect(fs.readdir?.("/workspace")).resolves.toEqual(["reports"]);
    await expect(fs.readdir?.("/workspace/reports/")).resolves.toEqual(["2026"]);
    await expect(fs.readdir?.("/workspace/reports/2026/")).resolves.toEqual([]);
  });

  test("deleting the last file keeps an explicitly created upload folder visible", async () => {
    const { fs } = createUploadFs({});

    await fs.mkdir?.("/workspace/reports", { recursive: true });
    await fs.writeFile?.("/workspace/reports/q1.txt", "ready");
    await fs.rm?.("/workspace/reports/q1.txt", { force: true });

    await expect(fs.exists?.("/workspace/reports/")).resolves.toBe(true);
    await expect(fs.readdir?.("/workspace")).resolves.toEqual(["reports"]);
    await expect(fs.readdir?.("/workspace/reports/")).resolves.toEqual([]);
  });

  test("recursive folder deletion removes upload directory markers too", async () => {
    const { fs, runtime } = createUploadFs({});

    await fs.mkdir?.("/workspace/reports/2026", { recursive: true });
    await fs.writeFile?.("/workspace/reports/2026/q1.txt", "ready");
    await fs.rm?.("/workspace/reports/", { recursive: true });

    await expect(fs.exists?.("/workspace/reports/")).resolves.toBe(false);
    await expect(fs.readdir?.("/workspace")).resolves.toEqual([]);
    expect(
      runtime.files.has(
        composeStorageKey(UPLOAD_PROVIDER_DATABASE, toUploadDirectoryMarkerFileKey("reports")),
      ),
    ).toBe(false);
    expect(
      runtime.files.has(
        composeStorageKey(UPLOAD_PROVIDER_DATABASE, toUploadDirectoryMarkerFileKey("reports/2026")),
      ),
    ).toBe(false);
  });

  test("directory-marker detection requires marker metadata", async () => {
    const { fs } = createUploadFs({
      "reports/.fragno/dir-marker": { content: "user file", metadata: null },
    });

    await expect(fs.readdir?.("/workspace/reports/")).resolves.toEqual([".fragno"]);
    await expect(fs.readdir?.("/workspace/reports/.fragno/")).resolves.toEqual(["dir-marker"]);
    await expect(fs.exists?.("/workspace/reports/.fragno/dir-marker")).resolves.toBe(true);
    await expect(fs.readFile?.("/workspace/reports/.fragno/dir-marker")).resolves.toBe("user file");
  });

  test("contributor createFileSystem returns null when uploads are unavailable", async () => {
    const fs = await uploadFileContributor.createFileSystem?.({
      orgId: "acme-org",
      backend: "backoffice",
      uploadConfig: null,
    });

    expect(fs).toBeNull();
  });
});

const createUploadFs = (
  seed: Record<
    string,
    {
      provider?: string;
      content: string | Uint8Array;
      contentType?: string;
      metadata?: Record<string, unknown> | null;
      status?: UploadFileRecord["status"];
    }
  >,
) => {
  const runtime = createUploadRuntime(seed);
  const context = {
    orgId: "acme-org",
    origin: runtime.baseUrl,
    backend: "pi" as const,
    uploadConfig: runtime.uploadConfig,
    uploadRuntime: runtime,
    request: new Request("https://docs.example.test/backoffice/files"),
  } satisfies FilesContext;

  return {
    runtime,
    context,
    fs: createUploadFileSystem(context),
  };
};

const createUploadRuntime = (
  seed: Record<
    string,
    {
      provider?: string;
      content: string | Uint8Array;
      contentType?: string;
      metadata?: Record<string, unknown> | null;
      status?: UploadFileRecord["status"];
    }
  >,
  uploadConfig: UploadAdminConfigResponse = createUploadConfig(),
) => {
  const now = new Date("2026-03-18T12:00:00.000Z").toISOString();
  const files = new Map<string, UploadFileRecord>();
  const contents = new Map<string, Uint8Array>();

  const setFile = (
    fileKey: string,
    input: {
      provider?: string;
      content: string | Uint8Array;
      contentType?: string;
      metadata?: Record<string, unknown> | null;
      status?: UploadFileRecord["status"];
    },
  ) => {
    const provider = input.provider ?? uploadConfig.defaultProvider ?? UPLOAD_PROVIDER_DATABASE;
    const bytes =
      input.content instanceof Uint8Array ? input.content : new TextEncoder().encode(input.content);
    const contentType = input.contentType ?? guessContentType(fileKey);

    contents.set(composeStorageKey(provider, fileKey), bytes);
    files.set(composeStorageKey(provider, fileKey), {
      provider,
      fileKey,
      status: input.status ?? "ready",
      sizeBytes: bytes.byteLength,
      filename: fileKey.split("/").at(-1) ?? fileKey,
      contentType,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    });
  };

  for (const [fileKey, input] of Object.entries(seed)) {
    setFile(fileKey, input);
  }

  const requests: string[] = [];

  return {
    baseUrl: "https://docs.example.test",
    uploadConfig,
    files,
    contents,
    requests,
    async fetch(request: Request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);

      if (request.method === "GET" && url.pathname === "/api/upload/files") {
        const provider = url.searchParams.get("provider");
        const status = url.searchParams.get("status");
        const prefix = url.searchParams.get("prefix") ?? "";
        const delimiter = url.searchParams.get("delimiter");
        const matchedFiles = Array.from(files.values()).filter(
          (file) =>
            (!provider || file.provider === provider) &&
            (!status || file.status === status) &&
            file.fileKey.startsWith(prefix),
        );

        if (delimiter === "/") {
          const directories = new Map<
            string,
            {
              name: string;
              prefix: string;
              updatedAt: string;
              contentType: string | null;
              metadata: Record<string, unknown> | null;
            }
          >();
          const directFiles: UploadFileRecord[] = [];
          for (const file of matchedFiles) {
            const remainder = file.fileKey.slice(prefix.length);
            const delimiterIndex = remainder.indexOf("/");
            if (delimiterIndex === -1) {
              directFiles.push(file);
              continue;
            }

            const name = remainder.slice(0, delimiterIndex);
            directories.set(`${prefix}${name}/`, {
              name,
              prefix: `${prefix}${name}/`,
              updatedAt: String(file.updatedAt ?? now),
              contentType: file.contentType ?? null,
              metadata: file.metadata ?? null,
            });
          }

          return Response.json({
            files: directFiles,
            directories: Array.from(directories.values()),
            hasNextPage: false,
          });
        }

        return Response.json({
          files: matchedFiles,
          hasNextPage: false,
        });
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
        if (!file || file.status === "deleted" || !content) {
          return Response.json({ message: "File not found." }, { status: 404 });
        }

        return new Response(new Uint8Array(content), {
          status: 200,
          headers: {
            "content-type": file.contentType,
          },
        });
      }

      if (request.method === "PATCH" && url.pathname === "/api/upload/files/by-key") {
        const provider = url.searchParams.get("provider") ?? "";
        const key = url.searchParams.get("key") ?? "";
        const storageKey = composeStorageKey(provider, key);
        const file = files.get(storageKey);
        if (!file) {
          return Response.json({ message: "File not found." }, { status: 404 });
        }

        const payload = (await request.json()) as {
          filename?: string;
          visibility?: string | null;
          tags?: string[] | null;
          metadata?: Record<string, unknown> | null;
        };
        const nextFile = {
          ...file,
          ...(payload.filename ? { filename: payload.filename } : {}),
          ...(payload.visibility !== undefined ? { visibility: payload.visibility } : {}),
          ...(payload.tags !== undefined ? { tags: payload.tags ?? [] } : {}),
          ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
          updatedAt: now,
        } satisfies UploadFileRecord;
        files.set(storageKey, nextFile);
        return Response.json(nextFile);
      }

      if (request.method === "DELETE" && url.pathname === "/api/upload/files/by-key") {
        const provider = url.searchParams.get("provider") ?? "";
        const key = url.searchParams.get("key") ?? "";
        files.delete(composeStorageKey(provider, key));
        contents.delete(composeStorageKey(provider, key));
        return Response.json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/upload/files") {
        const formData = await request.formData();
        const provider = String(formData.get("provider") ?? "");
        const fileKey = String(formData.get("fileKey") ?? "");
        const metadataValue = formData.get("metadata");
        const metadata =
          typeof metadataValue === "string" && metadataValue
            ? ((JSON.parse(metadataValue) as Record<string, unknown>) ?? null)
            : null;
        const blob = formData.get("file");
        if (!(blob instanceof Blob)) {
          return Response.json({ message: "File is required." }, { status: 400 });
        }

        setFile(fileKey, {
          provider,
          content: new Uint8Array(await blob.arrayBuffer()),
          contentType: blob.type || guessContentType(fileKey),
          metadata,
        });
        return Response.json(files.get(composeStorageKey(provider, fileKey)));
      }

      return new Response("Not Found", { status: 404 });
    },
  };
};

const composeStorageKey = (provider: string, fileKey: string) => `${provider}::${fileKey}`;

const guessContentType = (fileKey: string): string => {
  if (/\.png$/i.test(fileKey)) {
    return "image/png";
  }
  if (/\.(md|mdx)$/i.test(fileKey)) {
    return "text/markdown";
  }
  if (/\.json$/i.test(fileKey)) {
    return "application/json";
  }
  return "text/plain";
};

const readStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    result += decoder.decode(value, { stream: true });
  }

  result += decoder.decode();
  return result;
};
