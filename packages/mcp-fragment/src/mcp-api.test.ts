import { assert, expect, test } from "vitest";

import { z } from "zod";

import { createMcpHandler, McpServer, type Tool } from "@modelcontextprotocol/server";

import { callMcpTool, listMcpTools } from "./mcp-api";

const endpointUrl = "http://mcp.test/mcp";

test.each([{ value: [1, 2] }, { value: false }, { value: null }])(
  "lists and calls a modern tool with non-object structured output: $value",
  async ({ value }) => {
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: "structured-output", version: "1.0.0" });
        const outputSchema = z.union([z.array(z.number()), z.boolean(), z.null()]);
        server.registerTool(
          "reflect",
          { inputSchema: z.object({ value: outputSchema }), outputSchema },
          async ({ value }) => ({
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          }),
        );
        return server;
      },
      { legacy: "reject" },
    );
    const fetchImplementation: typeof fetch = (url, init) => handler.fetch(new Request(url, init));
    try {
      const listed = await listMcpTools({ endpointUrl, fetchImplementation });
      assert(listed.ok);
      assert(listed.metadata.protocolVersion === "2026-07-28");
      expect(listed.result.tools).toEqual([
        expect.objectContaining({ name: "reflect", outputSchema: expect.any(Object) }),
      ]);
      const called = await callMcpTool({
        endpointUrl,
        fetchImplementation,
        name: "reflect",
        toolArguments: { value },
      });
      assert(called.ok);
      expect(called.result.structuredContent).toEqual(value);
      expect(called.result).not.toHaveProperty("resultType");
    } finally {
      await handler.close();
    }
  },
);

test("aggregates every tools/list page rather than caching only the first page", async () => {
  const tools: Tool[] = [
    { name: "first", inputSchema: { type: "object" } },
    {
      name: "second",
      inputSchema: { type: "object" },
      outputSchema: { type: "array", items: { type: "string" } },
      icons: [{ src: "https://example.test/tool.svg", mimeType: "image/svg+xml" }],
    },
  ];
  const cursors: (string | undefined)[] = [];
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "paginated-tools", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.server.setRequestHandler("tools/list", async (request) => {
        cursors.push(request.params?.cursor);
        return request.params?.cursor === "second-page"
          ? { tools: tools.slice(1) }
          : { tools: tools.slice(0, 1), nextCursor: "second-page" };
      });
      return server;
    },
    { legacy: "reject" },
  );
  try {
    const listed = await listMcpTools({
      endpointUrl,
      fetchImplementation: (url, init) => handler.fetch(new Request(url, init)),
    });
    assert(listed.ok);
    expect(cursors).toEqual([undefined, "second-page"]);
    expect(listed.result.tools).toEqual(tools);
    expect(listed.result).not.toHaveProperty("nextCursor");
  } finally {
    await handler.close();
  }
});
