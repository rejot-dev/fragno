import {
  afterAll,
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { runInNewContext } from "node:vm";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { backofficeApiV0 } from "@fragno-dev/backoffice-api/v0";

import {
  getCurrentSystemMessage,
  getCurrentTools,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
  type KeybindingsManager,
  type McpTransportFactory,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component, type TUI } from "@earendil-works/pi-tui";

import registerCloudflareMcpCommand from "../cloudflare-mcp/index.js";

const nativeCodemodeExtension = {
  name: "native-codemode",
  factory: createCodemodeExtension(),
  replaceable: true,
};

let createTransport: McpTransportFactory;
let mcpConnections: string[];
let logQueries: string[];
let searchRequests: unknown[];
let directory: string;
let baseUrl: string;
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
      // Cloud requests routed to this server must see endpoints on the Cloud origin.
      const scenarioOrigin = request.headers["x-scenario-origin"];
      const origin =
        typeof scenarioOrigin === "string" ? scenarioOrigin : `http://${request.headers.host}`;
      try {
        if (request.url === "/api/auth/ok") {
          response.end(JSON.stringify({ ok: true }));
        } else if (request.url === "/api/backoffice/cli-config") {
          response.end(
            JSON.stringify({
              clientId: "scenario-client",
              scope: "backoffice",
              deviceAuthorizationEndpoint: `${origin}/oauth/device`,
              tokenEndpoint: `${origin}/oauth/token`,
              verificationUri: `${origin}/oauth/verify`,
            }),
          );
        } else if (request.url === "/api/backoffice/me") {
          response.end(
            JSON.stringify({
              user: {
                id: "scenario-user",
                email: "scenario@example.com",
                role: "user",
                jurisdiction: null,
              },
              activeOrganizationId: null,
              organizations: [],
            }),
          );
        } else if (request.url === `${scopedPath}/SYSTEM.md`) {
          response.setHeader("content-type", "text/markdown");
          response.end("Follow the Cloud scope instructions.");
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
              // Backoffice rejects input outside its published contract.
              searchFiles: (input: unknown) => {
                const { keywords, options } =
                  backofficeApiV0.operations["state.searchFiles"].input.parse(input);
                searchRequests.push({ keywords, options });
                const match = { line: 1, column: 1, match: "needle", lineText: "needle" };
                return {
                  upload: options?.upload?.cursor
                    ? { results: [{ path: "/workspace/b.md", matches: [match] }], hasMore: false }
                    : {
                        results: [{ path: "/workspace/a.md", matches: [match] }],
                        cursor: "upload-page-2",
                        hasMore: true,
                      },
                  static: { results: [], hasMore: false },
                };
              },
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
    fauxAssistantMessage([fauxToolCall("backofficeCodemode", { code })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Scenario completed."),
  ]);
  await session.prompt("Run the Backoffice codemode scenario.");
  const result = session.messages
    .toReversed()
    .find((message) => message.role === "toolResult" && message.toolName === "backofficeCodemode");
  if (result?.role !== "toolResult") {
    throw new Error("Backoffice scenario did not produce a backofficeCodemode result.");
  }
  return result;
}

/** Drives a `ctx.ui.custom` menu through its rendering and arrow keys, as a person would. */
async function openCustomMenu<T>(
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: T) => void,
  ) => Component | Promise<Component>,
  theme: Theme,
) {
  const result = Promise.withResolvers<T>();
  const component = await factory(
    { requestRender: () => {} } as unknown as TUI,
    theme,
    getKeybindings() as KeybindingsManager,
    result.resolve,
  );
  const handleInput = component.handleInput;
  assert(handleInput);
  const lines = () => component.render(120).map((line) => stripVTControlCharacters(line).trim());
  return {
    lines,
    result: result.promise,
    choose(label: string) {
      const target = lines().findIndex((line) => line.includes(label));
      const highlighted = lines().findIndex((line) => line.startsWith("→"));
      assert(target >= highlighted, `Menu has no choice below the highlight matching ${label}`);
      for (let step = highlighted; step < target; step++) {
        handleInput.call(component, "\x1b[B");
      }
      handleInput.call(component, "\r");
    },
    cancel() {
      handleInput.call(component, "\x1b");
    },
  };
}

describe("Backoffice extension scenarios", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-backoffice-codemode-"));
    process.env["BACKOFFICE_AUTH_FILE"] = join(directory, "backoffice-auth.json");
    // The MCP extension reads mcp.json from this variable, not from the session's agentDir.
    process.env["PI_CODING_AGENT_DIR"] = directory;
    // Pi's TUI initializes the theme before any custom component renders.
    initTheme();
    ({ default: registerBackofficeExtension } = await import("./index.js"));
  });

  beforeEach(async () => {
    await mkdir(join(directory, "remote"), { recursive: true });
    await writeFile(join(directory, "remote", "document.txt"), remoteText);
    await writeFile(join(directory, "document.txt"), "local-only content");
    baseUrl = await startBackofficeScenarioServer();
    // `/backoffice` probes this repository's worktree dev-server ports; scenarios must not reach
    // whatever the developer has running there.
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/auth/ok" && url.origin !== new URL(baseUrl).origin) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return realFetch(input, init);
    });
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

    mcpConnections = [];
    logQueries = [];
    searchRequests = [];
    createTransport = (entry) => {
      mcpConnections.push(entry.name);
      const { client, server } = createInMemoryTransportPair();
      server.onMessage((message) => {
        if (!("method" in message) || !("id" in message)) {
          return;
        }
        switch (message.method) {
          case "initialize": {
            const { protocolVersion } = message.params as { protocolVersion: string };
            void server.send({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: entry.name, version: "1.0.0" },
              },
            });
            break;
          }
          case "tools/list":
            void server.send({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                tools: [
                  {
                    name: "query_logs",
                    description: "Query Cloudflare Workers logs",
                    inputSchema: {
                      type: "object",
                      properties: { worker: { type: "string" } },
                      required: ["worker"],
                    },
                  },
                ],
              },
            });
            break;
          case "tools/call": {
            const { arguments: args } = message.params as { arguments: { worker: string } };
            logQueries.push(args.worker);
            void server.send({
              jsonrpc: "2.0",
              id: message.id,
              result: { content: [{ type: "text", text: `Logs for ${args.worker}` }] },
            });
            break;
          }
          default:
            void server.send({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32601,
                message: `Unsupported MCP scenario method: ${message.method}`,
              },
            });
        }
      });
      void server.start();
      return client;
    };
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"] });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        registerBackofficeExtension,
        registerCloudflareMcpCommand,
        createMcpExtension({ createTransport }),
        nativeCodemodeExtension,
      ],
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(directory);
    sessionManager.appendCustomEntry("backoffice-session", {
      baseUrl,
      scope: "user:scenario-user",
      systemPrompt: "Follow the scoped Backoffice instructions. Act through execCodeMode.",
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
    vi.restoreAllMocks();
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

  test("searches both mounts, then continues only the mount with more pages", async () => {
    const searchOptions = { contextBefore: 2, contextAfter: 2, maxMatches: 30 };
    const firstPage = await executeSessionTool("search", {
      keywords: ["needle", "haystack"],
      glob: "/workspace/**",
    });
    expect(firstPage.details).toMatchObject({
      continuation: { cursor: { upload: "upload-page-2" } },
    });

    const secondPage = await executeSessionTool("search", {
      keywords: ["needle", "haystack"],
      glob: "/workspace/**",
      cursor: { upload: "upload-page-2" },
    });
    expect(secondPage.structuredContent).toMatchObject({
      upload: { results: [{ path: "/workspace/b.md" }], hasMore: false },
    });
    expect(secondPage.details).toMatchObject({ continuation: null });
    expect(searchRequests).toEqual([
      {
        keywords: ["needle", "haystack"],
        options: { upload: searchOptions, static: searchOptions },
      },
      {
        keywords: ["needle", "haystack"],
        options: { upload: { ...searchOptions, cursor: "upload-page-2" } },
      },
    ]);
  });

  test("projects complete remote results while keeping local and remote files distinct", async () => {
    const directRead = await executeSessionTool("read", { path: "document.txt" });
    expect(directRead.details).toMatchObject({ truncated: true });
    expect(directRead.structuredContent).toBe(remoteText);
    const directExecution = await executeSessionTool("backofficeCodemode", {
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
    const empty = await executeSessionTool("backofficeCodemode", { code: "async () => null" });
    assert(empty.structuredContent === null);
  });

  test("queries observability through localCodemode and reuses the connection with Cloudflare mode", async () => {
    faux.setResponses([
      (context) => {
        const tools = getCurrentTools(context.messages);
        const names = tools.map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining(["localCodemode", "backofficeCodemode"]));
        expect(names).not.toContain("codemode");
        expect(names).not.toContain("execCodeMode");
        expect(tools.find((tool) => tool.name === "localCodemode")?.description).toContain(
          "local Pi sandbox",
        );
        expect(tools.find((tool) => tool.name === "backofficeCodemode")?.description).toContain(
          "remotely against the active Backoffice scope",
        );
        return fauxAssistantMessage(
          [
            fauxToolCall("localCodemode", {
              code: `
            const matches = await searchTools("Workers logs", {
              namespace: "mcp__cloudflare_observability",
            });
            text(await tools[matches[0].name]({ worker: "backoffice" }));
            text(await tools.localRead({ path: "document.txt" }));
            text({ hasBackofficeState: typeof state !== "undefined" });
            store("worker", "backoffice");
          `,
            }),
          ],
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("Workers logs inspected."),
    ]);
    await session.prompt("Inspect the Backoffice Worker logs.");
    const result = session.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "localCodemode",
    );
    assert(result?.role === "toolResult");
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Logs for backoffice"),
        }),
      ]),
    );
    expect(logQueries).toEqual(["backoffice"]);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("local-only content") }),
        expect.objectContaining({ text: expect.stringContaining('"hasBackofficeState":false') }),
      ]),
    );

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("localCodemode", {
            code: 'text(load("worker")); throw new Error("local scenario failure");',
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Local script failed."),
    ]);
    await session.prompt("Read the stored Worker name, then fail the local script.");
    const localFailure = session.messages
      .toReversed()
      .find((message) => message.role === "toolResult" && message.toolName === "localCodemode");
    assert(localFailure?.role === "toolResult");
    assert(localFailure.isError);
    expect(localFailure.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "backoffice" }),
        expect.objectContaining({ text: expect.stringContaining("local scenario failure") }),
      ]),
    );

    const remoteResult = await executeBackofficeProgram(
      'async () => "Remote Backoffice execution"',
    );
    expect(remoteResult).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "Remote Backoffice execution" }],
    });
    await session.prompt("/cloudflare");
    await expect
      .poll(() => session.getCallableToolNames().filter((name) => name.startsWith("mcp__")))
      .toHaveLength(3);
    expect(mcpConnections.filter((name) => name === "cloudflare-observability")).toHaveLength(1);

    const backofficeLeafId = session.sessionManager.getLeafId();
    assert(backofficeLeafId);
    session.sessionManager.appendCustomEntry("backoffice-session", null);
    const normalLeafId = session.sessionManager.getLeafId();
    assert(normalLeafId);
    await session.navigateTree(normalLeafId, { summarize: false });
    await session.navigateTree(backofficeLeafId, { summarize: false });
    expect(session.getActiveToolNames()).toContain("backofficeCodemode");
    expect(session.getActiveToolNames()).toContain("localCodemode");
    expect(mcpConnections.filter((name) => name === "cloudflare-observability")).toHaveLength(1);
  });

  test("reuses observability when Cloudflare mode connects before restoring a Backoffice branch", async () => {
    const backofficeLeafId = session.sessionManager.getLeafId();
    assert(backofficeLeafId);
    session.sessionManager.appendCustomEntry("backoffice-session", null);
    const services = await createAgentSessionServices({
      cwd: directory,
      agentDir: directory,
      settingsManager: SettingsManager.inMemory(),
      modelRuntime: session.modelRuntime,
      resourceLoaderOptions: {
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          registerBackofficeExtension,
          registerCloudflareMcpCommand,
          createMcpExtension({ createTransport }),
          nativeCodemodeExtension,
        ],
      },
    });
    const { session: restoredSession } = await createAgentSessionFromServices({
      services,
      model: faux.getModel(),
      sessionManager: session.sessionManager,
    });
    try {
      await restoredSession.bindExtensions({});
      const connectionCount = mcpConnections.filter(
        (name) => name === "cloudflare-observability",
      ).length;
      expect(restoredSession.getCallableToolNames()).not.toContain(
        "mcp__cloudflare_observability__query_logs",
      );

      await restoredSession.prompt("/cloudflare");
      await expect
        .poll(() =>
          restoredSession.getCallableToolNames().filter((name) => name.startsWith("mcp__")),
        )
        .toHaveLength(3);
      await restoredSession.navigateTree(backofficeLeafId, { summarize: false });
      expect(restoredSession.getActiveToolNames()).toContain("backofficeCodemode");
      expect(restoredSession.getActiveToolNames()).toContain("localCodemode");
      expect(mcpConnections.filter((name) => name === "cloudflare-observability")).toHaveLength(
        connectionCount + 1,
      );
    } finally {
      await restoredSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      restoredSession.dispose();
    }
  });

  test("offers Cloud at once and lists a local server when its probe answers", async () => {
    const probedOrigins: string[] = [];
    const answerProbe = Promise.withResolvers<void>();
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const { origin } = new URL(String(input));
      probedOrigins.push(origin);
      // The current worktree's server answers last; every other port is closed.
      if (probedOrigins.length > 1) {
        throw new TypeError("fetch failed");
      }
      await answerProbe.promise;
      return Response.json({ ok: true });
    });
    const opened = Promise.withResolvers<Awaited<ReturnType<typeof openCustomMenu>>>();
    const defaultUiContext = session.extensionRunner.getUIContext();
    await session.bindExtensions({
      mode: "tui",
      uiContext: {
        ...defaultUiContext,
        custom: async (factory) => {
          const menu = await openCustomMenu(factory, defaultUiContext.theme);
          opened.resolve(menu);
          return await menu.result;
        },
      },
    });

    const command = session.prompt("/backoffice");
    const menu = await opened.promise;
    expect(menu.lines()).toContain("→ Exit Backoffice (restore normal Pi)");
    expect(menu.lines()).toContain("Backoffice Cloud (backoffice.rejot.dev)");
    expect(menu.lines()).toContain("Looking for local Backoffice servers…");

    answerProbe.resolve();
    const localServer = `Local Backoffice (${probedOrigins[0]})`;
    await expect.poll(() => menu.lines()).toContain(localServer);
    expect(menu.lines()).not.toContain("Looking for local Backoffice servers…");
    menu.cancel();
    await command;
  });

  test("propagates remote execution failures through backofficeCodemode", async () => {
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

  test("exits and re-enters in place, preserving bug investigation context and restoring normal tools across reload", async () => {
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
          extensionFactories: [
            registerBackofficeExtension,
            createMcpExtension({ createTransport }),
            nativeCodemodeExtension,
          ],
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
    const selections = [
      undefined,
      "Exit Backoffice (restore normal Pi)",
      undefined,
      "Backoffice Cloud",
      "user:scenario-user",
      "Exit Backoffice (restore normal Pi)",
    ];
    const menus: string[][] = [];
    const notifications: string[] = [];
    const statuses = new Map<string, string>();
    const defaultUiContext = runtime.session.extensionRunner.getUIContext();
    const uiContext: ExtensionUIContext = {
      ...defaultUiContext,
      custom: async (factory) => {
        const menu = await openCustomMenu(factory, defaultUiContext.theme);
        menus.push(menu.lines());
        const selection = selections.shift();
        if (selection === undefined) {
          menu.cancel();
        } else {
          menu.choose(selection);
        }
        return await menu.result;
      },
      select: async (_title, options) => {
        menus.push([...options]);
        const selection = selections.shift();
        return selection === undefined
          ? undefined
          : options.find((option) => option.includes(selection));
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
          [fauxToolCall("backofficeCodemode", { code: 'async () => "Backoffice bug reproduced"' })],
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
      expect(runtime.session.getActiveToolNames()).toContain("backofficeCodemode");
      assert(statuses.has("backoffice"));

      await runtime.session.prompt("/backoffice");
      expect(runtime.session).toBe(originalSession);
      assert(runtime.session.sessionId === backofficeSessionId);
      expect(runtime.session.messages).toEqual(historyBeforeExit);
      expect(menus[0]).toContain("→ Exit Backoffice (restore normal Pi)");
      expect(menus[1]).toContain("→ Exit Backoffice (restore normal Pi)");
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
      expect(systemPromptOptions.customPrompt).toBeUndefined();
      faux.setResponses([
        (context) => {
          assert(
            context.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.content.some((block) => block.type === "text" && block.text === diagnosis),
            ),
          );
          // The Backoffice turn recorded its preamble; exiting patches the transcript's prompt.
          const currentPrompt = getCurrentSystemMessage(context.messages);
          assert(currentPrompt);
          expect(getSystemMessageText(currentPrompt)).toContain("operating inside pi");
          expect(getSystemMessageText(currentPrompt)).not.toContain(
            "Follow the scoped Backoffice instructions.",
          );
          const names = getCurrentTools(context.messages).map((tool) => tool.name);
          expect(names).toContain("codemode");
          expect(names).not.toContain("localCodemode");
          expect(names).not.toContain("backofficeCodemode");
          return fauxAssistantMessage(
            [
              fauxToolCall("codemode", {
                code: 'text(await tools.read({ path: "document.txt" }));',
              }),
              fauxToolCall("read", { path: "document.txt" }),
            ],
            {
              stopReason: "toolUse",
            },
          );
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
      const nativeResult = runtime.session.messages.find(
        (message) => message.role === "toolResult" && message.toolName === "codemode",
      );
      expect(nativeResult).toMatchObject({ isError: false });
      expect(nativeResult).toHaveProperty(
        "content",
        expect.arrayContaining([expect.objectContaining({ text: "local-only content" })]),
      );
      const normalSessionId = runtime.session.sessionId;
      await runtime.session.prompt("/backoffice");
      expect(menus[2]?.join("\n")).not.toContain("Exit Backoffice (restore normal Pi)");
      assert(runtime.session.sessionId === normalSessionId);

      const normalLeafId = runtime.session.sessionManager.getLeafId();
      assert(normalLeafId);
      await runtime.session.navigateTree(backofficeLeafId, { summarize: false });
      expect(runtime.session.getActiveToolNames()).toContain("backofficeCodemode");
      expect(runtime.session.getActiveToolNames()).toContain("localCodemode");
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

      // Re-entering continues the local fix in this session instead of starting a new one.
      const cloudUrl = "https://backoffice.rejot.dev";
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      await writeFile(
        join(directory, "backoffice-auth.json"),
        JSON.stringify({
          baseUrl: cloudUrl,
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
      const realFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith(cloudUrl)) {
          return realFetch(input, init);
        }
        const headers = new Headers(init?.headers);
        headers.set("x-scenario-origin", cloudUrl);
        return realFetch(`${baseUrl}${url.slice(cloudUrl.length)}`, { ...init, headers });
      });
      const historyBeforeReentry = [...runtime.session.messages];
      try {
        await runtime.session.prompt("/backoffice");
      } finally {
        vi.unstubAllGlobals();
      }
      expect(runtime.session).toBe(originalSession);
      assert(runtime.session.sessionId === normalSessionId);
      expect(runtime.session.messages).toEqual(historyBeforeReentry);
      expect(notifications).toContain(`Connected to ${cloudUrl} with scope user:scenario-user.`);
      expect(runtime.session.getActiveToolNames()).toContain("backofficeCodemode");
      assert(statuses.get("backoffice") === "backoffice:backoffice.rejot.dev");
      const reentered = await runtime.session.extensionRunner.emitBeforeAgentStart(
        "Continue in Backoffice",
        undefined,
        { cwd: directory },
      );
      expect(reentered.systemPromptOptions.customPrompt).toContain(
        "Follow the Cloud scope instructions.",
      );

      await runtime.session.prompt("/backoffice");
      assert(runtime.session.sessionId === normalSessionId);
      expect(new Set(runtime.session.getActiveToolNames())).toEqual(
        new Set(["read", "bash", "edit", "write", "codemode"]),
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
          extensionFactories: [
            registerBackofficeExtension,
            createMcpExtension({ createTransport }),
            nativeCodemodeExtension,
          ],
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

  test("keeps the scoped prompt in options that prompt-rebuilding providers forward", async () => {
    expect(session.getActiveToolNames()).toContain("backofficeCodemode");
    expect(session.getActiveToolNames()).toContain("localCodemode");
    const { systemPromptOptions } = await session.extensionRunner.emitBeforeAgentStart(
      "Use the Backoffice scope",
      undefined,
      {
        cwd: directory,
        contextFiles: [{ path: "AGENTS.md", content: "Local-only project instructions" }],
        sections: { mcp_servers: "Cloudflare MCP tools" },
        skills: [
          {
            name: "local-skill",
            description: "Local-only skill",
            filePath: join(directory, "SKILL.md"),
            baseDir: directory,
            sourceInfo: {
              path: join(directory, "SKILL.md"),
              source: "local",
              scope: "project",
              origin: "top-level",
            },
            disableModelInvocation: false,
          },
        ],
      },
    );
    // pi-claude-bridge rebuilds Claude Code's prompt from these options and ignores a forced one.
    expect(systemPromptOptions.forceSystemPrompt).toBeUndefined();
    expect(systemPromptOptions.customPrompt).toContain(
      "Follow the scoped Backoffice instructions.",
    );
    expect(systemPromptOptions.customPrompt).toContain("mcp__cloudflare_observability");
    expect(systemPromptOptions.customPrompt).toContain(
      "Use backofficeCodemode for remote Backoffice execution",
    );
    expect(systemPromptOptions.customPrompt).toContain(
      "Use localCodemode for local Pi and MCP tool scripts",
    );
    expect(systemPromptOptions.customPrompt).toContain("Act through backofficeCodemode.");
    expect(systemPromptOptions.customPrompt).not.toContain("execCodeMode");
    expect(systemPromptOptions.contextFiles).toEqual([]);
    expect(systemPromptOptions.skills).toEqual([]);
    expect(systemPromptOptions.sections["mcp_servers"]).toContain("mcp__cloudflare_observability");
  });
});
