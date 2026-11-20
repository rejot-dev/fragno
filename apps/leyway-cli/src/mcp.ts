import { backofficeCodemodeInputSchema } from "@fragno-dev/backoffice-api/v0/codemode";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import {
  executePersonalCodemode,
  fetchPersonalCodemodeSystemPrompt,
} from "@rejot-dev/backoffice-local";

import { McpServer } from "@modelcontextprotocol/server";

const systemUri = "leyway://codemode/SYSTEM.md";

export function serveLeywayMcp({ baseUrl, version }: { baseUrl: string; version: string }) {
  serveStdio(() => {
    const server = new McpServer(
      { name: "leyway", version },
      {
        instructions:
          "Sign in with leyway login. Read the Codemode guide at leyway://codemode/SYSTEM.md. " +
          "Each Codemode run starts in your personal Leyway workspace. Use Codemode context handles to work in other workspaces you can access.",
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      },
    );
    server.registerResource(
      "Codemode guide",
      systemUri,
      { mimeType: "text/markdown" },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: await fetchPersonalCodemodeSystemPrompt(baseUrl),
          },
        ],
      }),
    );
    server.registerTool(
      "codemode",
      {
        description:
          "Run a JavaScript Codemode function in your personal Leyway workspace. " +
          "Use context.org(organizationId) to call tools in another workspace you can access.",
        inputSchema: backofficeCodemodeInputSchema,
      },
      async (input, { mcpReq: { signal } }) => {
        const result = await executePersonalCodemode({ ...input, baseUrl, signal });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    );
    return server;
  });
}
