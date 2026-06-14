import { describe, expect, test, assert } from "vitest";

import {
  createMasterFileSystem,
  getFilesNodeDetail,
  listFilesChildren,
  listFilesTree,
  type FilesContext,
} from "@/files";
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
      },
    },
    [UPLOAD_PROVIDER_R2_BINDING]: {
      provider: UPLOAD_PROVIDER_R2_BINDING,
      configured: false,
    },
  },
  ...overrides,
});

describe("files service", () => {
  test("lists mounts in deterministic order", async () => {
    const runtime = createUploadRuntime();
    const master = await createMasterFileSystem({
      orgId: "org_123",
      backend: "backoffice",
      uploadConfig: runtime.uploadConfig,
      uploadRuntime: runtime,
    } satisfies FilesContext);

    expect(
      master.mounts.map((mount) => [mount.mountPoint, mount.id, mount.uploadProvider ?? null]),
    ).toEqual([
      ["/system", "system", null],
      ["/workspace", "workspace", UPLOAD_PROVIDER_DATABASE],
      ["/r2-remote", "r2-remote", UPLOAD_PROVIDER_R2],
      ["/tmp", "tmp", null],
    ]);
  });

  test("renders persistent /workspace detail when Upload is configured", async () => {
    const runtime = createUploadRuntime({
      "README.md": { content: "custom workspace readme" },
    });
    const master = await createMasterFileSystem({
      orgId: "org_123",
      backend: "backoffice",
      uploadConfig: runtime.uploadConfig,
      uploadRuntime: runtime,
    } satisfies FilesContext);

    const tree = await listFilesTree(master);
    expect(tree.map((node) => node.path)).toEqual(["/system", "/workspace", "/r2-remote", "/tmp"]);

    const workspaceChildren = await listFilesChildren(master, "/workspace");
    expect(workspaceChildren.map((node) => [node.kind, node.path, node.title])).toEqual([
      ["file", "/workspace/README.md", "README.md"],
    ]);

    const detail = await getFilesNodeDetail(master, "/workspace/README.md");
    assert(detail?.textContent === "custom workspace readme");
    expect(detail?.capabilities).toMatchObject({
      canCreateFolder: false,
      canWriteText: true,
      canDelete: true,
    });
    expect(detail?.fields).toEqual(
      expect.arrayContaining([
        { label: "Path", value: "/workspace/README.md" },
        { label: "Type", value: "File" },
        { label: "Persistence", value: "persistent" },
      ]),
    );

    const systemDetail = await getFilesNodeDetail(master, "/system/SYSTEM.md");
    expect(systemDetail?.node).toMatchObject({
      kind: "file",
      path: "/system/SYSTEM.md",
      title: "SYSTEM.md",
    });
    expect(systemDetail?.textContent).toContain("Backoffice");
  });

  test("renders upload-backed workspace file stats", async () => {
    const runtime = createUploadRuntime({
      "hello/logo.png": {
        content: new Uint8Array([137, 80, 78, 71]),
        contentType: "image/png",
      },
    });
    const master = await createMasterFileSystem({
      orgId: "org_123",
      backend: "backoffice",
      uploadConfig: runtime.uploadConfig,
      uploadRuntime: runtime,
      request: new Request("https://docs.example.test/backoffice/files/org_123?path=%2Fworkspace"),
    } satisfies FilesContext);

    const detail = await getFilesNodeDetail(master, "/workspace/hello/logo.png");
    expect(detail?.node).toMatchObject({
      kind: "file",
      path: "/workspace/hello/logo.png",
      sizeBytes: 4,
    });
  });

  test("preserves blob content types in the upload runtime stub", async () => {
    const runtime = createUploadRuntime();
    const formData = new FormData();
    formData.set("provider", UPLOAD_PROVIDER_R2);
    formData.set("fileKey", "hello/logo.png");
    formData.set(
      "file",
      new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
      "logo.png",
    );

    const response = await runtime.fetch(
      new Request("https://docs.example.test/api/upload/files", {
        method: "POST",
        body: formData,
      }),
    );

    assert(response.ok);
    expect((await response.json()) as UploadFileRecord).toMatchObject({
      provider: UPLOAD_PROVIDER_R2,
      fileKey: "hello/logo.png",
      contentType: "image/png",
    });
    expect(
      runtime.files.get(composeStorageKey(UPLOAD_PROVIDER_R2, "hello/logo.png")),
    ).toMatchObject({
      contentType: "image/png",
    });
  });

  test("does not mount workspace when Upload is unavailable", async () => {
    const master = await createMasterFileSystem({
      orgId: "org_123",
      backend: "backoffice",
      uploadConfig: null,
    } satisfies FilesContext);

    const tree = await listFilesTree(master);
    expect(tree.map((node) => node.path)).toEqual(["/system", "/tmp"]);

    const detail = await getFilesNodeDetail(master, "/system/SYSTEM.md");
    expect(detail?.textContent).toContain("Backoffice");
    expect(detail?.capabilities).toMatchObject({
      canCreateFolder: false,
      canWriteText: false,
      canDelete: false,
    });
  });

  test("returns empty results for unknown built-in paths", async () => {
    const master = await createMasterFileSystem({
      orgId: "org_123",
      backend: "backoffice",
      uploadConfig: null,
    } satisfies FilesContext);

    await expect(getFilesNodeDetail(master, "/workspace/missing.txt")).resolves.toBeNull();
    await expect(listFilesChildren(master, "/workspace/missing/")).resolves.toEqual([]);
  });
});

const createUploadRuntime = (
  seed: Record<
    string,
    { provider?: string; content: string | Uint8Array; contentType?: string }
  > = {},
) => {
  const now = new Date("2026-03-18T12:00:00.000Z").toISOString();
  const files = new Map<string, UploadFileRecord>();
  const contents = new Map<string, Uint8Array>();

  const setFile = (
    fileKey: string,
    input: { provider?: string; content: string | Uint8Array; contentType?: string },
  ) => {
    const provider = input.provider ?? UPLOAD_PROVIDER_DATABASE;
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
    files,
    contents,
    async fetch(request: Request) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/upload/files") {
        const provider = url.searchParams.get("provider");
        const prefix = url.searchParams.get("prefix") ?? "";
        const delimiter = url.searchParams.get("delimiter");
        const matchedFiles = Array.from(files.values()).filter(
          (file) => (!provider || file.provider === provider) && file.fileKey.startsWith(prefix),
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

        return Response.json({ files: matchedFiles, hasNextPage: false });
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
          headers: {
            "content-type": file.contentType,
          },
        });
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
        const blob = formData.get("file");
        if (!(blob instanceof Blob)) {
          return Response.json({ message: "File is required." }, { status: 400 });
        }

        const contentType = blob.type || guessContentType(fileKey);
        setFile(fileKey, {
          provider,
          content: new Uint8Array(await blob.arrayBuffer()),
          contentType,
        });
        return Response.json(files.get(composeStorageKey(provider, fileKey)));
      }

      return new Response("Not Found", { status: 404 });
    },
  } satisfies NonNullable<FilesContext["uploadRuntime"]> & {
    uploadConfig: UploadAdminConfigResponse;
    files: Map<string, UploadFileRecord>;
    contents: Map<string, Uint8Array>;
  };
};

const composeStorageKey = (provider: string, fileKey: string) => `${provider}::${fileKey}`;

const guessContentType = (fileKey: string): string => {
  if (/\.(md|mdx)$/i.test(fileKey)) {
    return "text/markdown";
  }
  if (/\.json$/i.test(fileKey)) {
    return "application/json";
  }
  return "text/plain";
};
