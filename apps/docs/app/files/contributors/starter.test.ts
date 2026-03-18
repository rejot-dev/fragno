import { describe, expect, test } from "vitest";

import {
  STARTER_FILE_MOUNT_POINT,
  STARTER_WORKSPACE_CONTENT,
  createStarterMountedFileSystem,
  normalizeMountedFileSystem,
  starterFileContributor,
  starterFileMount,
  type FilesContext,
  type MountedFileSystem,
  type MountedFileSystemResolution,
} from "@/files";
import {
  UPLOAD_PROVIDER_R2,
  UPLOAD_PROVIDER_R2_BINDING,
  type UploadAdminConfigResponse,
} from "@/fragno/upload";
import type { UploadFileRecord } from "@/routes/backoffice/connections/upload/data";

describe("starter file contributor", () => {
  test("exposes the /workspace mount metadata", async () => {
    expect(starterFileMount).toMatchObject({
      id: "workspace",
      kind: "starter",
      mountPoint: "/workspace",
      readOnly: true,
      persistence: "session",
    });
    expect(starterFileContributor).toMatchObject(starterFileMount);
  });

  test("renders and reads the starter workspace pack", async () => {
    const fs = createStarterMountedFileSystem();
    const entries = await fs.readdirWithFileTypes?.(STARTER_FILE_MOUNT_POINT);
    const readme = await fs.readFile?.(`${STARTER_FILE_MOUNT_POINT}/README.md`);

    expect(entries?.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["README.md", "input", "output", "prompts"]),
    );
    expect(fs.getAllPaths?.()).toEqual(
      expect.arrayContaining([
        "/workspace",
        ...Object.keys(STARTER_WORKSPACE_CONTENT).map((path) => `/workspace/${path}`),
      ]),
    );
    expect(readme).toContain("Workspace starter pack");
  });

  test("falls back to a read-only starter workspace when Upload is unavailable", async () => {
    const resolved = unwrapResolution(
      await starterFileContributor.createFileSystem?.({
        orgId: "acme-org",
        backend: "pi",
        uploadConfig: null,
      }),
    );

    expect(resolved.mount).toMatchObject({
      readOnly: true,
      persistence: "session",
    });
    await expect(resolved.fs.readFile("/workspace/README.md")).resolves.toContain(
      "Workspace starter pack",
    );
    await expect(resolved.fs.writeFile("/workspace/new.md", "hello")).rejects.toThrow(/read-only/i);
  });

  test("layers persistent upload overrides over starter workspace files", async () => {
    const runtime = createUploadRuntime({
      "README.md": { content: "custom readme" },
    });

    const resolved = unwrapResolution(
      await starterFileContributor.createFileSystem?.({
        orgId: "acme-org",
        backend: "pi",
        uploadConfig: runtime.uploadConfig,
        uploadRuntime: runtime,
      }),
    );

    expect(resolved.mount).toMatchObject({
      readOnly: false,
      persistence: "persistent",
      uploadProvider: UPLOAD_PROVIDER_R2,
    });

    await expect(resolved.fs.readFile?.("/workspace/README.md")).resolves.toBe("custom readme");
    await expect(resolved.fs.readFile?.("/workspace/input/notes.md")).resolves.toContain("# Notes");

    await resolved.fs.writeFile?.(
      "/workspace/output/generated.txt",
      "hello from persistent overlay",
    );
    await expect(resolved.fs.readFile?.("/workspace/output/generated.txt")).resolves.toBe(
      "hello from persistent overlay",
    );
    expect(runtime.files.has(composeStorageKey(UPLOAD_PROVIDER_R2, "output/generated.txt"))).toBe(
      true,
    );

    await resolved.fs.rm?.("/workspace/README.md", { force: true });
    await expect(resolved.fs.readFile?.("/workspace/README.md")).resolves.toContain(
      "Workspace starter pack",
    );
    await expect(resolved.fs.rm?.("/workspace/input/notes.md", { force: true })).rejects.toThrow(
      /starter read layer/i,
    );
  });
});

const unwrapResolution = (
  resolved: MountedFileSystemResolution | null | undefined,
): { fs: MountedFileSystem; mount: Record<string, unknown> } => {
  if (!resolved) {
    throw new Error("Expected a mounted filesystem resolution.");
  }

  if ("fs" in resolved) {
    return {
      fs: normalizeMountedFileSystem(resolved.fs, {
        readOnly: Boolean(resolved.mount?.readOnly),
      }),
      mount: resolved.mount ?? {},
    };
  }

  return {
    fs: normalizeMountedFileSystem(resolved),
    mount: {},
  };
};

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
    input: {
      provider?: string;
      content: string | Uint8Array;
      contentType?: string;
    },
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
    baseUrl: "https://pi.internal",
    uploadConfig: createUploadConfig(),
    files,
    contents,
    async fetch(request: Request) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/upload/files") {
        return Response.json({
          files: Array.from(files.values()),
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

        setFile(fileKey, {
          provider,
          content: new Uint8Array(await blob.arrayBuffer()),
          contentType: blob.type || guessContentType(fileKey),
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
