import { describe, expect, test, vi, assert } from "vitest";

import { INTERACTIVE_CHAT_WORKFLOW_NAME } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";

import { InMemoryAdapter } from "@fragno-dev/db";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import * as files from "@/files";
import { EMPTY_BASH_HOST_CONTEXT } from "@/fragno/runtime-tools/bash-host.test-utils";
import { createUnavailableAutomationRouterRuntime } from "@/fragno/runtime-tools/families/automations-routing";
import { UPLOAD_PROVIDER_DATABASE, type UploadAdminConfigResponse } from "@/fragno/upload";
import type { UploadFileRecord } from "@/routes/backoffice/connections/upload/data";

import { createTestMasterFileSystem } from "../automation/engine/test-master-file-system.test-utils";
import {
  createPiRuntime,
  createPiToolRegistry,
  type PiBashCommandContext,
  type PiSessionFileSystemContext,
} from "./pi";
import { loadBackofficePiSkills } from "./pi-skills";

const testRuntimeConfig: BackofficeRuntimeConfig = {
  transactionalEmails: { enabled: false },
  bindings: {
    api: false,
    auth: false,
    automations: false,
    billing: false,
    telegram: false,
    otp: false,
    pi: false,
    resend: false,
    reson8: false,
    mcp: false,
    upload: false,
    github: false,
    githubWebhookRouter: false,
    sandbox: false,
  },
};

const createMockEnv = () =>
  ({
    UPLOAD: { idFromName: () => "stub", get: () => ({}) },
    RESEND: { idFromName: () => "stub", get: () => ({}) },
    RESON8: { idFromName: () => "stub", get: () => ({}) },
    AUTOMATIONS: { idFromName: () => "stub", get: () => ({}) },
  }) as unknown as CloudflareEnv;

const createMockBashContext = (): PiBashCommandContext => ({
  ...EMPTY_BASH_HOST_CONTEXT,
  automation: null,
  automations: {
    runtime: {
      ...createUnavailableAutomationRouterRuntime(),
      get: async () => {
        throw new Error("not available in test");
      },
      set: async () => {
        throw new Error("not available in test");
      },
      delete: async () => {
        throw new Error("not available in test");
      },
      list: async () => {
        throw new Error("not available in test");
      },
    },
  },
  otp: {
    runtime: {
      createClaim: async () => {
        throw new Error("not available in test");
      },
    },
  },
  pi: {
    runtime: {
      createSession: async () => {
        throw new Error("not available in test");
      },
      getSession: async () => {
        throw new Error("not available in test");
      },
      listSessions: async () => {
        throw new Error("not available in test");
      },
      runTurn: async () => {
        throw new Error("not available in test");
      },
    },
  },
  reson8: {
    runtime: {
      transcribePrerecorded: async () => {
        throw new Error("not available in test");
      },
    },
  },
  resend: {
    runtime: {
      listThreads: async () => {
        throw new Error("not available in test");
      },
      getThread: async () => {
        throw new Error("not available in test");
      },
      listThreadMessages: async () => {
        throw new Error("not available in test");
      },
      getThreadSnapshot: async () => {
        throw new Error("not available in test");
      },
      replyToThread: async () => {
        throw new Error("not available in test");
      },
    },
  },
  telegram: {
    runtime: {
      getFile: async () => {
        throw new Error("not available in test");
      },
      downloadFile: async () => {
        throw new Error("not available in test");
      },
      sendMessage: async () => {
        throw new Error("not available in test");
      },
      sendChatAction: async () => {
        throw new Error("not available in test");
      },
      editMessage: async () => {
        throw new Error("not available in test");
      },
    },
  },
});

describe("Backoffice Pi fragment", () => {
  test("rejects unknown model names before creating the session", async () => {
    const context = createContext();
    const runtime = createPiRuntime({
      config: {
        scope: { kind: "org", orgId: "acme-org" },
        apiKeys: { openai: "test-key" },
        harnesses: [
          {
            id: "default",
            label: "Default",
            systemPrompt: "Test system prompt",
            tools: ["read"],
          },
        ],
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
      },
      adapters: {
        createAdapter: () => new InMemoryAdapter({ idSeed: "pi-invalid-model-test" }),
      } as never,
      env: createMockEnv(),
      sessionFileSystems: new Map(),
      sessionFileSystemContext: context,
      bashCommandContext: createMockBashContext(),
      codemode: {
        env: {} as never,
        execute: async () => {
          throw new Error("codemode not available in test");
        },
      },
    });

    const response = await runtime.piFragment.handler(
      new Request(`http://test.local/api/pi/workflows/${INTERACTIVE_CHAT_WORKFLOW_NAME}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { harnessName: "default::openai::bla" } }),
      }),
    );

    assert(response.status === 400);
    await expect(response.json()).resolves.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: "Model openai/bla not found.",
    });

    const listResponse = await runtime.piFragment.callRoute(
      "GET",
      "/workflows/:workflowName/sessions",
      {
        pathParams: { workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME },
      },
    );
    assert(listResponse.type === "json");
    expect(listResponse.data).toEqual([]);
  });
});

describe("Backoffice Pi skills", () => {
  test("loads starter skills from the Pi filesystem", async () => {
    const context = createContext();
    const fs = await files.createBackofficeFileSystem({
      ...context,
      config: context.runtimeConfig,
    });
    const skills = await loadBackofficePiSkills(fs);

    expect(Object.keys(skills)).toContain("building-automations");
    expect(skills["building-automations"]).toMatchObject({
      location: "/static/skills/building-automations/SKILL.md",
      directory: "/static/skills/building-automations",
    });
    expect(skills["building-automations"]?.body).toContain("events.catalogList");
  });

  test("reflects skills from the mounted virtual filesystem", async () => {
    const fs = createTestMasterFileSystem({
      "/workspace/skills/custom/SKILL.md": `---
name: custom
description: Use custom filesystem skill.
---

# Custom Skill

Filesystem-defined instructions.
`,
    });

    const skills = await loadBackofficePiSkills(fs);

    expect(Object.keys(skills)).toEqual(["custom"]);
    expect(skills.custom).toMatchObject({
      name: "custom",
      description: "Use custom filesystem skill.",
      location: "/workspace/skills/custom/SKILL.md",
    });
  });

  test("exposes a read tool that can load starter skill files", async () => {
    const tools = createPiToolRegistry({
      sessionFileSystems: new Map(),
      sessionFileSystemContext: createContext(),
    });

    const readFactory = tools.read;
    if (typeof readFactory !== "function") {
      throw new Error("Expected read to be registered as a factory.");
    }

    const readTool = await readFactory({
      session: { id: "session-skill-read" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
    } as never);

    assert(readTool.name === "read");
    const result = await readTool.execute("tool-call-skill-1", {
      path: "/static/skills/building-automations/SKILL.md",
      offset: 1,
      limit: 8,
    } as never);

    expect(result.details).toMatchObject({
      path: "/static/skills/building-automations/SKILL.md",
      offset: 1,
      limit: 8,
    });
    const content = result.content[0];
    assert(content?.type === "text");
    expect(content?.type === "text" ? content.text : "").toContain("name: building-automations");
  });
});

describe("Pi bash tool", () => {
  test("defaults just-bash to the shared filesystem root so pwd and ls work without an explicit cwd", async () => {
    const tools = createPiToolRegistry({
      sessionFileSystems: new Map(),
      sessionFileSystemContext: createContext(),
      env: createMockEnv(),
      bashCommandContext: createMockBashContext(),
    });

    const bashFactory = tools.bash;
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-1" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
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
      "dev",
      "projects",
      "resend",
      "static",
      "tmp",
    ]);
  });

  test("respects an explicit cwd inside the static starter filesystem", async () => {
    const tools = createPiToolRegistry({
      sessionFileSystems: new Map(),
      sessionFileSystemContext: createContext(),
      env: createMockEnv(),
      bashCommandContext: createMockBashContext(),
    });

    const bashFactory = tools.bash;
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-2" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
    } as never);

    const result = await tool.execute("tool-call-3", {
      script: "ls",
      cwd: "/static",
    } as never);
    expect(result.details).toMatchObject({
      stderr: "",
      exitCode: 0,
    });
    expect((result.details as { stdout: string }).stdout.split("\n")).toEqual([
      "SYSTEM.md",
      "automations",
      "codemode",
      "skills",
    ]);
  });

  test("exposes starter automation files inside the shared Pi filesystem", async () => {
    const tools = createPiToolRegistry({
      sessionFileSystems: new Map(),
      sessionFileSystemContext: createContext(),
      env: createMockEnv(),
      bashCommandContext: createMockBashContext(),
    });

    const bashFactory = tools.bash;
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-automations" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
    } as never);

    const result = await tool.execute("tool-call-automations-1", {
      script: "cat /static/automations/project-files-configure.workflow.js",
    } as never);
    expect(result.details).toMatchObject({
      stderr: "",
      exitCode: 0,
    });
    expect((result.details as { stdout: string }).stdout).toContain("project-files-configure");
  });

  test("mounts resend thread snapshots when a resend runtime is available", async () => {
    const tools = createPiToolRegistry({
      sessionFileSystems: new Map(),
      sessionFileSystemContext: createContext({ resend: true }),
      env: createMockEnv(),
      bashCommandContext: createMockBashContext(),
    });

    const bashFactory = tools.bash;
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-resend" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
    } as never);

    const listResult = await tool.execute("tool-call-resend-1", {
      script: "ls /resend",
    } as never);
    expect(listResult.details).toMatchObject({
      stderr: "",
      exitCode: 0,
    });
    assert((listResult.details as { stdout: string }).stdout === "thread-1.md");

    const readResult = await tool.execute("tool-call-resend-2", {
      script: "cat /resend/thread-1.md",
    } as never);
    expect(readResult.details).toMatchObject({
      stderr: "",
      exitCode: 0,
    });
    expect((readResult.details as { stdout: string }).stdout).toContain("# Invoice Update");
  });

  test("uses the shared workspace storage for reads and writes", async () => {
    const tools = createPiToolRegistry({
      sessionFileSystems: new Map(),
      sessionFileSystemContext: createContext({
        uploadSeed: { "README.md": "custom workspace readme" },
      }),
      env: createMockEnv(),
      bashCommandContext: createMockBashContext(),
    });

    const bashFactory = tools.bash;
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-3" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
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
    const tools = createPiToolRegistry({
      sessionFileSystems: new Map(),
      sessionFileSystemContext: createContext({
        uploadSeed: {
          "output/result.txt": { content: "stale", status: "deleted" },
        },
      }),
      env: createMockEnv(),
      bashCommandContext: createMockBashContext(),
    });

    const bashFactory = tools.bash;
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-deleted-ls" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
    } as never);

    const parentListResult = await tool.execute("tool-call-deleted-1", {
      script: "ls /workspace/output",
    } as never);
    expect(parentListResult.details).toMatchObject({
      stdout: "",
      exitCode: 2,
    });
    expect((parentListResult.details as { stderr: string }).stderr).toContain(
      "No such file or directory",
    );

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
    const tools = createPiToolRegistry({
      sessionFileSystems: new Map(),
      sessionFileSystemContext: createContext(),
      env: createMockEnv(),
      bashCommandContext: createMockBashContext(),
    });

    const bashFactory = tools.bash;
    if (typeof bashFactory !== "function") {
      throw new Error("Expected bash tool to be registered as a factory.");
    }

    const tool = await bashFactory({
      session: { id: "session-readonly-errors" },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
    } as never);

    const touchResult = await tool.execute("tool-call-readonly-1", {
      script: "touch /static/SYSTEM.md",
    } as never);
    expect(touchResult.details).toMatchObject({
      stdout: "",
      exitCode: 1,
    });
    expect((touchResult.details as { stderr: string }).stderr).toMatch(/read-only file system/i);
  });

  test("deduplicates concurrent session filesystem initialization", async () => {
    const createBackofficeFileSystem = files.createBackofficeFileSystem;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const createBackofficeFileSystemSpy = vi
      .spyOn(files, "createBackofficeFileSystem")
      .mockImplementation(async (options) => {
        await gate;
        return createBackofficeFileSystem(options);
      });

    try {
      const tools = createPiToolRegistry({
        sessionFileSystems: new Map(),
        sessionFileSystemContext: createContext({
          uploadSeed: { "README.md": "custom workspace readme" },
        }),
        env: createMockEnv(),
        bashCommandContext: createMockBashContext(),
      });

      const bashFactory = tools.bash;
      if (typeof bashFactory !== "function") {
        throw new Error("Expected bash tool to be registered as a factory.");
      }

      const toolContext = {
        session: { id: "session-race" },
        turnId: "turn-1",
        toolConfig: null,
        messages: [],
      } as never;

      const firstToolPromise = bashFactory(toolContext);
      const secondToolPromise = bashFactory(toolContext);

      await Promise.resolve();
      expect(createBackofficeFileSystemSpy).toHaveBeenCalledTimes(1);

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
      createBackofficeFileSystemSpy.mockRestore();
    }
  });
});

type UploadSeed = Record<
  string,
  | string
  | Uint8Array
  | {
      content: string | Uint8Array;
      contentType?: string;
      metadata?: Record<string, unknown> | null;
      status?: UploadFileRecord["status"];
    }
>;

const createContext = (
  options: { uploadSeed?: UploadSeed; resend?: boolean } = {},
): PiSessionFileSystemContext => {
  const upload = createUploadStub(options.uploadSeed ?? {});
  const resend = options.resend ? createResendStub() : createEmptyStub();
  const automations = createEmptyStub();

  const objects = {
    upload: { forOrg: () => upload },
    resend: { forOrg: () => resend },
    automations: { forOrg: () => automations },
  } as unknown as PiSessionFileSystemContext["objects"];

  return {
    scope: { kind: "org", orgId: "acme-org" },
    objects,
    kernel: new BackofficeKernel({ objects }),
    runtimeConfig: testRuntimeConfig,
    execution: {
      actor: {
        type: "user",
        id: "test-user",
        userId: "test-user",
        organizationIds: ["acme-org"],
      },
      scope: { kind: "org", orgId: "acme-org" },
    },
  };
};

const createEmptyStub = () => ({
  fetch: async () => new Response("Not Found", { status: 404 }),
  getHookQueue: async () => ({
    configured: false,
    hooksEnabled: false,
    namespace: null,
    items: [],
    cursor: undefined,
    hasNextPage: false,
  }),
  getAdminConfig: async () => null,
});

const createUploadConfig = (): UploadAdminConfigResponse => ({
  configured: true,
  defaultProvider: UPLOAD_PROVIDER_DATABASE,
  providers: {
    [UPLOAD_PROVIDER_DATABASE]: {
      provider: UPLOAD_PROVIDER_DATABASE,
      configured: true,
      config: {},
    },
  },
});

const createUploadStub = (seed: UploadSeed) => {
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
      provider: UPLOAD_PROVIDER_DATABASE,
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
    getAdminConfig: async () => (Object.keys(seed).length > 0 ? createUploadConfig() : null),
    async fetch(request: Request) {
      const url = new URL(request.url);

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

const createResendStub = () => ({
  async fetch(request: Request) {
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
