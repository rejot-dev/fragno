import { codemodeCallsSchema } from "@fragno-dev/backoffice-api/v0/pi";
import { codemodeLogLineSchema } from "@fragno-dev/codemode/runtime-api";
import { z } from "zod";

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { renderCodemodeSystemPrompt } from "@/fragno/codemode/codemode-dts";
import { renderCodemodeGlobalsSummary } from "@/fragno/codemode/codemode-type-files";
import {
  backofficeCodemodeInputSchema,
  executeInteractiveCodemode,
} from "@/fragno/codemode/interactive-execute";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";
import { codemodeCallsDetail } from "@/fragno/pi/extensions/backoffice/codemode-call-details";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { apiError } from "./api-error";

const systemUri = "leyway://codemode/SYSTEM.md";

// MCP requires an object at the root of an output schema, so success and failure share one shape.
const codemodeOutputSchema = z.object({
  ok: z.boolean(),
  runId: z.string(),
  // What the program returned; null when it failed or returned nothing. The output schema requires
  // the field, and JSON drops `undefined`, so clients would reject a run whose effects happened.
  result: z.unknown(),
  error: z.string().nullable(),
  logs: z.array(codemodeLogLineSchema),
  // What each provider call did; the run's history keeps their inputs and outputs under `runId`.
  calls: codemodeCallsSchema,
});

const codemodeToolDescription = [
  "Run a JavaScript Codemode program, `async () => { ... }`, in your personal Leyway workspace.",
  renderCodemodeGlobalsSummary(runtimeToolFamilies),
  "Use context.org(organizationId) to call tools in another workspace you can access.",
  "From a script, pass `code` as a String.raw template literal so its backslashes reach the program as written.",
].join(" ");

export async function serveLeywayMcp(
  request: Request,
  { runtime, kernel }: { runtime: BackofficeRuntimeServices; kernel: BackofficeKernel },
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) {
    return apiError("forbidden", "The request origin is not allowed.");
  }

  const authorization = await runtime.objects.auth.singleton().commands.authorizeMcpRequest({
    url: request.url,
    method: request.method,
    authorization: request.headers.get("authorization"),
    dpop: request.headers.get("dpop"),
  });
  if (authorization.kind === "rejected") {
    return new Response(authorization.body, {
      status: authorization.status,
      headers: authorization.headers,
    });
  }
  const { scope } = authorization;

  // Codemode context handles resolve live user permissions in the workspace they address.
  const execution = createBackofficeUserExecution({ scope, userId: scope.userId });
  const mcp = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "leyway", version: "v0" },
        {
          instructions:
            "Read the Codemode guide at leyway://codemode/SYSTEM.md before your first run. " +
            "Each Codemode run starts in your personal Leyway workspace. Use Codemode context handles to work in other workspaces you can access.",
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        },
      );
      server.registerResource(
        "Codemode guide",
        systemUri,
        { mimeType: "text/markdown" },
        async (uri) => {
          const state = createRuntimeStateBackend({ runtime, kernel, execution });
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "text/markdown",
                text: await renderCodemodeSystemPrompt({ audience: "mcp", state }),
              },
            ],
          };
        },
      );
      server.registerTool(
        "codemode",
        {
          description: codemodeToolDescription,
          inputSchema: backofficeCodemodeInputSchema,
          outputSchema: codemodeOutputSchema,
        },
        async (body) => {
          const startedAt = Date.now();
          const run = await executeInteractiveCodemode({ body, execution, runtime, kernel });
          // Only Leyway's own agents start inline workflows, and get notified when they end.
          const error = run.workflowDefinition
            ? "A top-level defineWorkflow is not started over MCP. Save it as the default export of a .workflow.js file, then start it with workflow.createInstance({ path, instanceId })."
            : (run.error ?? null);
          const output: z.infer<typeof codemodeOutputSchema> = {
            ok: error === null,
            runId: run.runId,
            result: run.result ?? null,
            error,
            logs: run.logs,
            calls: codemodeCallsDetail(run.toolCalls, startedAt),
          };
          return {
            isError: !output.ok,
            structuredContent: output,
            // For clients that read only text, as MCP asks of tools with structured results.
            content: [{ type: "text", text: JSON.stringify(output) }],
          };
        },
      );
      return server;
    },
    // 2025-11-25 clients such as pi connect with `initialize`; each of their requests is answered on its own.
    { legacy: "stateless" },
  );
  const response = await mcp.fetch(request);
  response.headers.set("cache-control", "no-store");
  return response;
}
