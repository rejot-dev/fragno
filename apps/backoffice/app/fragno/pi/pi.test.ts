import { beforeEach, describe, expect, test, vi } from "vitest";

import * as files from "@/files";
import { resetFileContributorsForTest } from "@/files";
import { UPLOAD_PROVIDER_R2, type UploadAdminConfigResponse } from "@/fragno/upload";
import type { UploadFileRecord } from "@/routes/backoffice/connections/upload/data";

import {
  createPiToolRegistry,
  type PiSessionResendRuntime,
  type PiSessionUploadRuntime,
} from "./pi";

describe("Pi bash tool", () => {
  beforeEach(() => {
    resetFileContributorsForTest();
  });

  test("defaults just-bash to the shared filesystem root so pwd and ls work without an explicit cwd", async () => {
    const tools = createPiToolRegistry(new Map(), {
      orgId: "acme-org",
      uploadRuntime: createUploadRuntime(),
    });

    const bashFactory = tools["bash"];
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-1" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
      replay: { journal: [], sideEffects: {} },
    } as never);

    const pwdResult = await tool.execute("tool-call-1", {
      script: "pwd",
    } as never);
    expect(pwdResult.details).toMatchObject({
      stdout: "/",
      stderr: "",
      exitCode: 0,
    });

    const lsResult = await tool.execute("tool-call-2", {
      script: "ls",
    } as never);
    expect(lsResult.details).toMatchObject({
      stderr: "",
      exitCode: 0,
    });
    expect((lsResult.details as { stdout: string }).stdout.split("\n")).toEqual([
      "system",
      "workspace",
    ]);
  });

  test("respects an explicit cwd inside the shared Pi filesystem", async () => {
    const tools = createPiToolRegistry(new Map(), {
      orgId: "acme-org",
      uploadRuntime: createUploadRuntime(),
    });

    const bashFactory = tools["bash"];
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-2" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
      replay: { journal: [], sideEffects: {} },
    } as never);

    const result = await tool.execute("tool-call-3", {
      script: "ls",
      cwd: "/workspace",
    } as never);
    expect(result.details).toMatchObject({
      stderr: "",
      exitCode: 0,
    });
    expect((result.details as { stdout: string }).stdout.split("\n")).toEqual([
      "README.md",
      "automations",
      "input",
      "output",
      "prompts",
    ]);
  });

  test("exposes starter automation files inside the shared Pi filesystem", async () => {
    const tools = createPiToolRegistry(new Map(), {
      orgId: "acme-org",
      uploadRuntime: createUploadRuntime(),
    });

    const bashFactory = tools["bash"];
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-automations" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
      replay: { journal: [], sideEffects: {} },
    } as never);

    const result = await tool.execute("tool-call-automations-1", {
      script: "cat /workspace/automations/bindings.json",
    } as never);
    expect(result.details).toMatchObject({
      stderr: "",
      exitCode: 0,
    });
    expect((result.details as { stdout: string }).stdout).toContain(
      '"telegram-claim-linking-start"',
    );
  });

  test("mounts resend thread snapshots when a resend runtime is available", async () => {
    const tools = createPiToolRegistry(new Map(), {
      orgId: "acme-org",
      uploadRuntime: createUploadRuntime(),
      resendRuntime: createResendRuntime(),
    });

    const bashFactory = tools["bash"];
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-resend" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
      replay: { journal: [], sideEffects: {} },
    } as never);

    const listResult = await tool.execute("tool-call-resend-1", {
      script: "ls /resend",
    } as never);
    expect(listResult.details).toMatchObject({
      stderr: "",
      exitCode: 0,
    });
    expect((listResult.details as { stdout: string }).stdout).toBe("thread-1.md");

    const readResult = await tool.execute("tool-call-resend-2", {
      script: "cat /resend/thread-1.md",
    } as never);
    expect(readResult.details).toMatchObject({
      stderr: "",
      exitCode: 0,
    });
    expect((readResult.details as { stdout: string }).stdout).toContain("# Invoice Update");
  });

  test("uses the shared workspace overlay for reads and writes", async () => {
    const tools = createPiToolRegistry(new Map(), {
      orgId: "acme-org",
      uploadRuntime: createUploadRuntime({
        "README.md": "custom workspace readme",
      }),
    });

    const bashFactory = tools["bash"];
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-3" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
      replay: { journal: [], sideEffects: {} },
    } as never);

    const readResult = await tool.execute("tool-call-4", {
      script: "cat /workspace/README.md",
    } as never);
    expect(readResult.details).toMatchObject({
      stdout: "custom workspace readme",
      stderr: "",
      exitCode: 0,
    });

    const writeResult = await tool.execute("tool-call-5", {
      script: "printf 'hello from pi' > /workspace/output/result.txt",
    } as never);
    expect(writeResult.details).toMatchObject({
      stderr: "",
      exitCode: 0,
    });

    const verifyResult = await tool.execute("tool-call-6", {
      script: "cat /workspace/output/result.txt",
    } as never);
    expect(verifyResult.details).toMatchObject({
      stdout: "hello from pi",
      stderr: "",
      exitCode: 0,
    });
  });

  test("reports deleted upload-backed paths as missing for exact ls lookups", async () => {
    const tools = createPiToolRegistry(new Map(), {
      orgId: "acme-org",
      uploadRuntime: createUploadRuntime({
        "output/result.txt": {
          content: "stale",
          status: "deleted",
        },
      }),
    });

    const bashFactory = tools["bash"];
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-deleted-ls" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
      replay: { journal: [], sideEffects: {} },
    } as never);

    const parentListResult = await tool.execute("tool-call-deleted-1", {
      script: "ls /workspace/output",
    } as never);
    expect(parentListResult.details).toMatchObject({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const exactPathResult = await tool.execute("tool-call-deleted-2", {
      script: "ls /workspace/output/result.txt",
    } as never);
    expect(exactPathResult.details).toMatchObject({
      stdout: "",
      exitCode: 2,
    });
    expect((exactPathResult.details as { stderr: string }).stderr).toContain(
      "No such file or directory",
    );
  });

  test("surfaces read-only filesystem errors for touch", async () => {
    const tools = createPiToolRegistry(new Map(), {
      orgId: "acme-org",
      uploadRuntime: createUploadRuntime(),
    });

    const bashFactory = tools["bash"];
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-readonly-errors" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
      replay: { journal: [], sideEffects: {} },
    } as never);

    const touchResult = await tool.execute("tool-call-readonly-1", {
      script: "touch /workspace/README.md",
    } as never);
    expect(touchResult.details).toMatchObject({
      stdout: "",
      exitCode: 1,
    });
    expect((touchResult.details as { stderr: string }).stderr).toMatch(/read-only file system/i);
  });

  test("deduplicates concurrent session filesystem initialization", async () => {
    const createMasterFileSystem = files.createMasterFileSystem;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const createMasterFileSystemSpy = vi
      .spyOn(files, "createMasterFileSystem")
      .mockImplementation(async (options) => {
        await gate;
        return createMasterFileSystem(options);
      });

    try {
      const tools = createPiToolRegistry(new Map(), {
        orgId: "acme-org",
        uploadRuntime: createUploadRuntime({
          "README.md": "custom workspace readme",
        }),
      });

      const bashFactory = tools["bash"];
      if (typeof bashFactory !== "function") {
        throw new Error("Expected bash tool to be registered as a factory.");
      }

      const toolContext = {
        session: { id: "session-race" },
        turnId: "turn-1",
        toolConfig: null,
        messages: [],
        replay: { journal: [], sideEffects: {} },
      } as never;

      const firstToolPromise = bashFactory(toolContext);
      const secondToolPromise = bashFactory(toolContext);

      await Promise.resolve();
      expect(createMasterFileSystemSpy).toHaveBeenCalledTimes(1);

      release();

      const [firstTool, secondTool] = await Promise.all([firstToolPromise, secondToolPromise]);

      const writeResult = await firstTool.execute("tool-call-7", {
        script: "printf 'race-free' > /workspace/output/race.txt",
      } as never);
      expect(writeResult.details).toMatchObject({
        stderr: "",
        exitCode: 0,
      });

      const readResult = await secondTool.execute("tool-call-8", {
        script: "cat /workspace/output/race.txt",
      } as never);
      expect(readResult.details).toMatchObject({
        stdout: "race-free",
        stderr: "",
        exitCode: 0,
      });
    } finally {
      createMasterFileSystemSpy.mockRestore();
    }
  });
});

const createUploadConfig = (): UploadAdminConfigResponse => ({
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
  },
});

const createUploadRuntime = (
  seed: Record<
    string,
    | string
    | Uint8Array
    | {
        content: string | Uint8Array;
        contentType?: string;
        metadata?: Record<string, unknown> | null;
        status?: UploadFileRecord["status"];
      }
  > = {},
): PiSessionUploadRuntime => {
  const now = new Date("2026-03-18T12:00:00.000Z").toISOString();
  const files = new Map<string, UploadFileRecord>();
  const contents = new Map<string, Uint8Array>();

  const setFile = (
    fileKey: string,
    input:
      | string
      | Uint8Array
      | {
          content: string | Uint8Array;
          contentType?: string;
          metadata?: Record<string, unknown> | null;
          status?: UploadFileRecord["status"];
        },
  ) => {
    const normalizedInput =
      typeof input === "string" || input instanceof Uint8Array ? { content: input } : input;
    const bytes =
      normalizedInput.content instanceof Uint8Array
        ? normalizedInput.content
        : new TextEncoder().encode(normalizedInput.content);
    files.set(fileKey, {
      provider: UPLOAD_PROVIDER_R2,
      fileKey,
      status: normalizedInput.status ?? "ready",
      sizeBytes: bytes.byteLength,
      filename: fileKey.split("/").at(-1) ?? fileKey,
      contentType: normalizedInput.contentType ?? guessContentType(fileKey),
      metadata: normalizedInput.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    });
    contents.set(fileKey, bytes);
  };

  for (const [fileKey, content] of Object.entries(seed)) {
    setFile(fileKey, content);
  }

  return {
    baseUrl: "https://pi.internal",
    uploadConfig: Object.keys(seed).length > 0 ? createUploadConfig() : null,
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/upload/files") {
        const status = url.searchParams.get("status");
        return Response.json({
          files: Array.from(files.values()).filter((file) => !status || file.status === status),
          hasNextPage: false,
        });
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
        const key = url.searchParams.get("key") ?? "";
        const file = files.get(key);
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
        files.set(key, nextFile);
        return Response.json(nextFile);
      }

      if (request.method === "DELETE" && url.pathname === "/api/upload/files/by-key") {
        const key = url.searchParams.get("key") ?? "";
        files.delete(key);
        contents.delete(key);
        return Response.json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/upload/files") {
        const formData = await request.formData();
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
          content: new Uint8Array(await blob.arrayBuffer()),
          contentType: blob.type || guessContentType(fileKey),
          metadata,
        });
        return Response.json(files.get(fileKey));
      }

      return new Response("Not Found", { status: 404 });
    },
  };
};

const createResendRuntime = (): PiSessionResendRuntime => ({
  baseUrl: "https://pi.internal",
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/resend/threads") {
      return Response.json({
        threads: [
          {
            id: "thread-1",
            subject: "Invoice Update",
            normalizedSubject: "invoice update",
            participants: ["customer@example.com", "support@example.com"],
            messageCount: 1,
            firstMessageAt: "2026-03-18T12:00:00.000Z",
            lastMessageAt: "2026-03-18T12:00:00.000Z",
            lastDirection: "outbound",
            lastMessagePreview: "Hello there",
            createdAt: "2026-03-18T12:00:00.000Z",
            updatedAt: "2026-03-18T12:00:00.000Z",
          },
        ],
        hasNextPage: false,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/resend/threads/thread-1/messages") {
      return Response.json({
        messages: [
          {
            id: "message-1",
            threadId: "thread-1",
            direction: "outbound",
            status: "sent",
            from: "support@example.com",
            to: ["customer@example.com"],
            cc: [],
            bcc: [],
            replyTo: [],
            subject: "Invoice Update",
            normalizedSubject: "invoice update",
            participants: ["customer@example.com", "support@example.com"],
            messageId: null,
            inReplyTo: null,
            references: [],
            providerEmailId: "provider-1",
            attachments: [],
            html: null,
            text: "Hello there",
            headers: null,
            occurredAt: "2026-03-18T12:00:00.000Z",
            scheduledAt: null,
            sentAt: "2026-03-18T12:00:00.000Z",
            lastEventType: null,
            lastEventAt: null,
            errorCode: null,
            errorMessage: null,
            createdAt: "2026-03-18T12:00:00.000Z",
            updatedAt: "2026-03-18T12:00:00.000Z",
          },
        ],
        hasNextPage: false,
      });
    }

    return Response.json({ message: "Not found.", code: "THREAD_NOT_FOUND" }, { status: 404 });
  },
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
