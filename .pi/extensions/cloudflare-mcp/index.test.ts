import { assert, expect, test } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";

import { getSystemMessageText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type McpTransportFactory,
} from "@earendil-works/pi-coding-agent";

import registerCloudflareMcpCommand from "./index.js";

test("Cloudflare stays opt-in and native codemode discovers and calls its MCP servers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cloudflare-mcp-"));
  const counters = new Map<string, number>();
  const createTransport: McpTransportFactory = (entry) => {
    const { client, server } = createInMemoryTransportPair();
    counters.set(entry.name, 0);
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
                  name: "increment_count",
                  description: "Increment this server's count by an amount",
                  inputSchema: {
                    type: "object",
                    properties: { amount: { type: "number" } },
                    required: ["amount"],
                  },
                },
              ],
            },
          });
          break;
        case "tools/call": {
          const { arguments: args } = message.params as { arguments: { amount: number } };
          const count = counters.get(entry.name)! + args.amount;
          counters.set(entry.name, count);
          void server.send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: String(count) }],
              structuredContent: { count },
            },
          });
          break;
        }
        default:
          void server.send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `Unsupported MCP scenario method: ${message.method}` },
          });
      }
    });
    void server.start();
    return client;
  };
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      createCodemodeExtension(),
      createMcpExtension({ createTransport }),
      registerCloudflareMcpCommand,
    ],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, "pi-auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const faux = fauxProvider();
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(directory),
  });
  try {
    await session.bindExtensions({});
    assert.equal(counters.size, 0);
    expect(session.getActiveToolNames()).not.toContain("codemode");

    await session.prompt("/cloudflare");
    await expect.poll(() => session.getActiveToolNames()).toContain("codemode");
    await expect
      .poll(() => session.getCallableToolNames().filter((name) => name.startsWith("mcp__")))
      .toHaveLength(3);
    expect([...counters.keys()].sort()).toEqual([
      "cloudflare",
      "cloudflare-docs",
      "cloudflare-observability",
    ]);
    assert(!session.getActiveToolNames().some((name) => name.startsWith("mcp__")));

    await session.prompt("/cloudflare");
    assert.equal(counters.size, 3);
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: `
              const matches = await searchTools("increment count", { limit: 10 });
              const results = await Promise.all(matches.map(({ name }, index) =>
                tools[name]({ amount: index + 1 })
              ));
              text(results.reduce((sum, result) => sum + result.structuredContent.count, 0));
            `,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Scenario completed."),
    ]);
    await session.prompt("Increment the counts through Cloudflare MCP tools.");
    const result = session.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "codemode",
    );
    expect(result).toMatchObject({ isError: false });
    expect([...counters.values()].sort((left, right) => left - right)).toEqual([1, 2, 3]);
    const prompt = session.messages
      .filter((message) => message.role === "system")
      .map(getSystemMessageText)
      .join("\n");
    expect(prompt).toContain("<mcp_servers>");
    expect(prompt).toContain("<cloudflare_mode>");
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
