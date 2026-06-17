import { describe, expect, test } from "vitest";

import type { McpRuntime } from "../runtime-tools/families/mcp-runtime";
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
  test("does not fail codemode when MCP is bound but not configured for the organisation", async () => {
    const providers = await createMcpCodemodeProviders({
      runtime: createRuntime({
        listServers: async () => {
          throw new Error("MCP is not configured for this organisation.");
        },
      }),
    });

    expect(providers).toEqual([]);
  });

  test("surfaces unexpected MCP provider discovery errors", async () => {
    await expect(
      createMcpCodemodeProviders({
        runtime: createRuntime({
          listServers: async () => {
            throw new Error("MCP exploded");
          },
        }),
      }),
    ).rejects.toThrow("MCP exploded");
  });
});
