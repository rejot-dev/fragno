import { describe, expect, test } from "vitest";

import type { McpRuntime } from "../runtime-tools/families/mcp-runtime";
import { NotConfiguredError } from "../runtime-tools/runtime-errors";
import { createTrustedSystemBackofficeToolContext } from "../runtime-tools/runtime-tools";
import { createMcpCodemodeProviders } from "./mcp-codemode-tools";

const createRuntime = (overrides: Partial<McpRuntime>): McpRuntime =>
  ({
    listServers: async () => ({ servers: [] }),
    createServer: async () => {
      throw new Error("not implemented");
    },
    deleteServer: async () => {
      throw new Error("not implemented");
    },
    refreshServer: async () => {
      throw new Error("not implemented");
    },
    callTool: async () => {
      throw new Error("not implemented");
    },
    startOAuth: async () => {
      throw new Error("not implemented");
    },
    setToken: async () => {
      throw new Error("not implemented");
    },
    getAuthStatus: async () => {
      throw new Error("not implemented");
    },
    ...overrides,
  }) as McpRuntime;

describe("MCP codemode providers", () => {
  const context = createTrustedSystemBackofficeToolContext({ runtimes: {} });

  test("does not fail codemode when MCP is bound but not configured for the scope", async () => {
    const providers = await createMcpCodemodeProviders({
      context,
      runtime: createRuntime({
        listServers: async () => {
          throw new NotConfiguredError("MCP is not configured for this scope.");
        },
      }),
    });

    expect(providers).toEqual([]);
  });

  test("surfaces unexpected MCP provider discovery errors", async () => {
    await expect(
      createMcpCodemodeProviders({
        context,
        runtime: createRuntime({
          listServers: async () => {
            throw new Error("MCP exploded");
          },
        }),
      }),
    ).rejects.toThrow("MCP exploded");
  });
});
