import { afterAll, afterEach, assert, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

import { getSystemMessageText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

let directory: string;
let session: AgentSession;
let server: ReturnType<typeof createServer>;
let faux: ReturnType<typeof fauxProvider>;
let registerBackofficeExtension: (typeof import("./index.js"))["default"];
const originalAuthFile = process.env["BACKOFFICE_AUTH_FILE"];
const remoteText = Array.from(
  { length: 2200 },
  (_, index) => `remote line ${index}: complete Backoffice scope file content`,
).join("\n");

async function startBackofficeScenarioServer() {
  const scopedPath = "/api/backoffice/codemode/user/scenario-user";
  server = createServer((request, response) => {
    void handleRequest();
    async function handleRequest() {
      response.setHeader("content-type", "application/json");
      try {
        if (request.url === "/api/auth/ok") {
          response.end(JSON.stringify({ ok: true }));
        } else if (request.url === "/api/backoffice/cli-config") {
          response.end(
            JSON.stringify({
              clientId: "scenario-client",
              scope: "backoffice",
              deviceAuthorizationEndpoint: `http://${request.headers.host}/oauth/device`,
              tokenEndpoint: `http://${request.headers.host}/oauth/token`,
              verificationUri: `http://${request.headers.host}/oauth/verify`,
            }),
          );
        } else if (request.url === "/api/backoffice/me") {
          response.end(
            JSON.stringify({
              user: { id: "scenario-user", email: "scenario@example.com", role: "user" },
              activeOrganizationId: null,
              organizations: [],
            }),
          );
        } else if (request.url === scopedPath && request.method === "POST") {
          if (request.headers.authorization !== "Bearer scenario-backoffice-token") {
            response.writeHead(401).end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const { code } = JSON.parse(Buffer.concat(chunks).toString()) as { code: string };
          const result = await runInNewContext(`(${code})()`, {
            state: {
              readFile: ({ path }: { path: string }) =>
                readFile(join(directory, "remote", path), "utf8"),
            },
          });
          response.end(JSON.stringify({ ok: true, result }));
        } else {
          response.writeHead(404).end();
        }
      } catch (error) {
        response.end(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Backoffice scenario server did not bind a loopback port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function executeSessionTool(name: string, args: Record<string, unknown>) {
  const tool = session.getToolDefinition(name);
  if (!tool) {
    throw new Error(`Backoffice scenario tool is unavailable: ${name}`);
  }
  return tool.execute(
    `scenario-${name}`,
    args,
    undefined,
    undefined,
    session.extensionRunner.createToolContext(`scenario-${name}`, undefined),
  );
}

async function executeBackofficeProgram(code: string) {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("execCodeMode", { code })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Scenario completed."),
  ]);
  await session.prompt("Run the Backoffice codemode scenario.");
  const result = session.messages
    .toReversed()
    .find((message) => message.role === "toolResult" && message.toolName === "execCodeMode");
  if (result?.role !== "toolResult") {
    throw new Error("Backoffice scenario did not produce an execCodeMode result.");
  }
  return result;
}

describe("Backoffice extension scenarios", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-backoffice-codemode-"));
    process.env["BACKOFFICE_AUTH_FILE"] = join(directory, "backoffice-auth.json");
    ({ default: registerBackofficeExtension } = await import("./index.js"));
  });

  beforeEach(async () => {
    await mkdir(join(directory, "remote"), { recursive: true });
    await writeFile(join(directory, "remote", "document.txt"), remoteText);
    await writeFile(join(directory, "document.txt"), "local-only content");
    const baseUrl = await startBackofficeScenarioServer();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await writeFile(
      join(directory, "backoffice-auth.json"),
      JSON.stringify({
        baseUrl,
        oauth: {
          clientId: "scenario-client",
          accessToken: "scenario-oauth-token",
          accessTokenExpiresAt: expiresAt,
          refreshToken: "scenario-refresh-token",
        },
        backoffice: {
          accessToken: "scenario-backoffice-token",
          expiresAt,
          scope: { kind: "user", userId: "scenario-user" },
        },
      }),
    );

    const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"] });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createCodemodeExtension(), registerBackofficeExtension],
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(directory);
    sessionManager.appendCustomEntry("backoffice-session", {
      baseUrl,
      scope: "user:scenario-user",
      systemPrompt: "Follow the scoped Backoffice instructions.",
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(directory, "pi-auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    faux = fauxProvider();
    modelRuntime.registerNativeProvider(faux.provider);
    ({ session } = await createAgentSession({
      model: faux.getModel(),
      cwd: directory,
      agentDir: directory,
      modelRuntime,
      resourceLoader,
      settingsManager,
      sessionManager,
    }));
    await session.bindExtensions({});
  });

  afterEach(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  afterAll(async () => {
    if (originalAuthFile === undefined) {
      delete process.env["BACKOFFICE_AUTH_FILE"];
    } else {
      process.env["BACKOFFICE_AUTH_FILE"] = originalAuthFile;
    }
    await rm(directory, { recursive: true, force: true });
  });

  test("projects complete remote results while keeping local and remote files distinct", async () => {
    const directRead = await executeSessionTool("read", { path: "document.txt" });
    expect(directRead.details).toMatchObject({ truncated: true });
    expect(directRead.structuredContent).toBe(remoteText);
    const directExecution = await executeSessionTool("execCodeMode", {
      code: 'async () => ({ text: await state.readFile({ path: "document.txt" }) })',
    });
    expect(directExecution.details).toMatchObject({ truncated: true });
    expect(directExecution.structuredContent).toEqual({ text: remoteText });

    const result = await executeBackofficeProgram(`async () => {
      const text = await state.readFile({ path: "document.txt" });
      return { remoteLength: text.length, empty: null };
    }`);
    expect(result.isError).not.toBe(true);
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const projection = JSON.parse(text) as { remoteLength: number; empty: null };
    assert(projection.remoteLength === remoteText.length);
    assert(projection.empty === null);
    await executeSessionTool("localWrite", {
      path: "summary.txt",
      content: String(projection.remoteLength),
    });
    const localRead = await executeSessionTool("localRead", { path: "document.txt" });
    expect(localRead.content).toEqual([{ type: "text", text: "local-only content" }]);
    expect(await readFile(join(directory, "summary.txt"), "utf8")).toBe(String(remoteText.length));
    const empty = await executeSessionTool("execCodeMode", { code: "async () => null" });
    assert(empty.structuredContent === null);
  });

  test("propagates remote execution failures through execCodeMode", async () => {
    const result = await executeBackofficeProgram(
      'async () => { throw new Error("remote scenario failure"); }',
    );
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert(result.isError);
    expect(text).toContain("Codemode execution failed:");
    expect(text).toContain("remote scenario failure");
  });

  test("exits in place, preserving bug investigation context and restoring normal tools across reload", async () => {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(directory, "pi-auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
      const services = await createAgentSessionServices({
        cwd: options.cwd,
        agentDir: options.agentDir,
        settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"] }),
        modelRuntime,
        resourceLoaderOptions: {
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [createCodemodeExtension(), registerBackofficeExtension],
        },
      });
      return {
        ...(await createAgentSessionFromServices({
          services,
          model: faux.getModel(),
          sessionManager: options.sessionManager,
          sessionStartEvent: options.sessionStartEvent,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: directory,
      agentDir: directory,
      sessionManager: session.sessionManager,
    });
    const selections = [undefined, "Exit Backoffice (restore normal Pi)", undefined];
    const menus: string[][] = [];
    const notifications: string[] = [];
    const statuses = new Map<string, string>();
    const uiContext: ExtensionUIContext = {
      ...runtime.session.extensionRunner.getUIContext(),
      select: async (_title, options) => {
        menus.push([...options]);
        return selections.shift();
      },
      notify: (message) => {
        notifications.push(message);
      },
      setStatus: (key, text) => {
        if (text === undefined) {
          statuses.delete(key);
        } else {
          statuses.set(key, text);
        }
      },
    };
    async function bindSession(activeSession: AgentSession) {
      await activeSession.bindExtensions({
        mode: "tui",
        uiContext,
        commandContextActions: {
          waitForIdle: () => activeSession.waitForIdle(),
          newSession: (options) => runtime.newSession(options),
          fork: (entryId, options) => runtime.fork(entryId, options),
          navigateTree: (entryId, options) => activeSession.navigateTree(entryId, options),
          switchSession: (path, options) => runtime.switchSession(path, options),
          reload: () => activeSession.reload(),
        },
      });
    }
    runtime.setRebindSession(bindSession);
    try {
      await bindSession(runtime.session);
      const originalSession = runtime.session;
      const backofficeSessionId = runtime.session.sessionId;
      const diagnosis = "Found a Backoffice bug; fix it in the local workspace.";
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("execCodeMode", { code: 'async () => "Backoffice bug reproduced"' })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(diagnosis),
      ]);
      await runtime.session.prompt("Investigate the Backoffice bug.");
      const historyBeforeExit = [...runtime.session.messages];
      const backofficeLeafId = runtime.session.sessionManager.getLeafId();
      assert(backofficeLeafId);
      assert(statuses.has("backoffice"));
      await runtime.session.prompt("/backoffice");
      assert(runtime.session.sessionId === backofficeSessionId);
      expect(runtime.session.getActiveToolNames()).toContain("execCodeMode");
      assert(statuses.has("backoffice"));

      await runtime.session.prompt("/backoffice");
      expect(runtime.session).toBe(originalSession);
      assert(runtime.session.sessionId === backofficeSessionId);
      expect(runtime.session.messages).toEqual(historyBeforeExit);
      assert(menus[0]?.[0] === "Exit Backoffice (restore normal Pi)");
      assert(menus[1]?.[0] === "Exit Backoffice (restore normal Pi)");
      expect(new Set(runtime.session.getActiveToolNames())).toEqual(
        new Set(["read", "bash", "edit", "write", "codemode"]),
      );
      assert(!statuses.has("backoffice"));
      expect(notifications).toContain(
        "Exited Backoffice. Normal Pi tools restored in this session.",
      );
      await runtime.session.reload();
      expect(runtime.session).toBe(originalSession);
      assert(runtime.session.sessionId === backofficeSessionId);
      expect(runtime.session.messages).toEqual(historyBeforeExit);
      expect(new Set(runtime.session.getActiveToolNames())).toEqual(
        new Set(["read", "bash", "edit", "write", "codemode"]),
      );
      const { systemPromptOptions } = await runtime.session.extensionRunner.emitBeforeAgentStart(
        "Read a local file",
        undefined,
        { cwd: directory },
      );
      expect(systemPromptOptions.forceSystemPrompt).toBeUndefined();
      faux.setResponses([
        (context) => {
          assert(
            context.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.content.some((block) => block.type === "text" && block.text === diagnosis),
            ),
          );
          const leadingPrompt = context.messages[0];
          assert(leadingPrompt?.role === "system");
          expect(getSystemMessageText(leadingPrompt)).not.toContain(
            "Follow the scoped Backoffice instructions.",
          );
          return fauxAssistantMessage([fauxToolCall("read", { path: "document.txt" })], {
            stopReason: "toolUse",
          });
        },
        fauxAssistantMessage("Normal Pi session."),
      ]);
      await runtime.session.prompt("Read the local document.");
      const result = runtime.session.messages.find(
        (message) => message.role === "toolResult" && message.toolName === "read",
      );
      expect(result).toMatchObject({
        isError: false,
        content: [{ type: "text", text: "local-only content" }],
      });
      const normalSessionId = runtime.session.sessionId;
      await runtime.session.prompt("/backoffice");
      expect(menus[2]).not.toContain("Exit Backoffice (restore normal Pi)");
      assert(runtime.session.sessionId === normalSessionId);

      const normalLeafId = runtime.session.sessionManager.getLeafId();
      assert(normalLeafId);
      await runtime.session.navigateTree(backofficeLeafId, { summarize: false });
      expect(runtime.session.getActiveToolNames()).toContain("execCodeMode");
      expect(runtime.session.getActiveToolNames()).not.toContain("codemode");
      assert(statuses.has("backoffice"));
      expect(runtime.session.getToolDefinition("read")?.description).toContain(
        "active Backoffice scope",
      );
      await runtime.session.navigateTree(normalLeafId, { summarize: false });
      expect(new Set(runtime.session.getActiveToolNames())).toEqual(
        new Set(["read", "bash", "edit", "write", "codemode"]),
      );
      assert(!statuses.has("backoffice"));
      expect(runtime.session.getToolDefinition("read")?.description).not.toContain(
        "active Backoffice scope",
      );
    } finally {
      await runtime.dispose();
    }
  });

  test.each([
    { reason: "reload", normalTools: ["read", "grep"] },
    { reason: "resume", normalTools: ["read", "grep"] },
    { reason: "reload", normalTools: [] },
    { reason: "resume", normalTools: [] },
  ] as const)(
    "restores saved tools $normalTools on fresh-runtime $reason after exiting Backoffice",
    async ({ reason, normalTools }) => {
      session.sessionManager.appendCustomEntry("backoffice-normal-tools", [...normalTools]);
      session.sessionManager.appendCustomEntry("backoffice-session", null);
      const services = await createAgentSessionServices({
        cwd: directory,
        agentDir: directory,
        settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"] }),
        modelRuntime: session.modelRuntime,
        resourceLoaderOptions: {
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [createCodemodeExtension(), registerBackofficeExtension],
        },
      });
      const { session: restoredSession } = await createAgentSessionFromServices({
        services,
        model: faux.getModel(),
        sessionManager: session.sessionManager,
        sessionStartEvent: { type: "session_start", reason },
      });
      try {
        await restoredSession.bindExtensions({});
        expect(new Set(restoredSession.getActiveToolNames())).toEqual(new Set(normalTools));
        expect(restoredSession.getToolDefinition("read")?.description).not.toContain(
          "active Backoffice scope",
        );
      } finally {
        await restoredSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        restoredSession.dispose();
      }
    },
  );

  test("keeps Backoffice's sole executor and scoped prompt despite global native codemode settings", async () => {
    expect(session.getActiveToolNames()).toContain("execCodeMode");
    expect(session.getActiveToolNames()).not.toContain("codemode");
    const { systemPromptOptions } = await session.extensionRunner.emitBeforeAgentStart(
      "Use the Backoffice scope",
      undefined,
      {
        cwd: directory,
        contextFiles: [{ path: "AGENTS.md", content: "Local-only project instructions" }],
        sections: { mcp_servers: "Cloudflare MCP tools" },
      },
    );
    assert(systemPromptOptions.forceSystemPrompt === "Follow the scoped Backoffice instructions.");
  });
});
