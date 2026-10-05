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

import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
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
