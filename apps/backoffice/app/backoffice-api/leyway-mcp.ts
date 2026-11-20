import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  McpServer,
  OAuthError,
  OAuthErrorCode,
} from "@modelcontextprotocol/server";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  BackofficeExecutionTokenAuthenticationError,
  BackofficeExecutionTokenScopeError,
} from "@/fragno/auth/execution-token";
import {
  LEYWAY_MCP_OAUTH_SCOPES,
  LEYWAY_MCP_RESOURCE_METADATA_PATH,
} from "@/fragno/auth/mcp-oauth";
import { renderCodemodeSystemPrompt } from "@/fragno/codemode/codemode-dts";
import {
  backofficeCodemodeInputSchema,
  executeInteractiveCodemode,
} from "@/fragno/codemode/interactive-execute";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";

import { apiError } from "./api-error";

const systemUri = "leyway://codemode/SYSTEM.md";

export async function serveLeywayMcp(
  request: Request,
  { runtime, kernel }: { runtime: BackofficeRuntimeServices; kernel: BackofficeKernel },
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) {
    return apiError("forbidden", "The request origin is not allowed.");
  }

  function challenge(message: string) {
    return bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, message), {
      requiredScopes: [...LEYWAY_MCP_OAUTH_SCOPES],
      resourceMetadataUrl: new URL(LEYWAY_MCP_RESOURCE_METADATA_PATH, url).href,
    });
  }

  const authorization = request.headers.get("authorization");
  const bearer = /^Bearer\s+([^\s]+)$/iu.exec(authorization ?? "");
  if (!bearer) {
    return challenge("Sign in to Leyway to use MCP.");
  }
  let scope;
  try {
    scope = await runtime.objects.auth.singleton().commands.authorizeMcpUser({
      requestUrl: request.url,
      oauthAccessToken: bearer[1],
    });
  } catch (error) {
    if (error instanceof Error && error.name === BackofficeExecutionTokenAuthenticationError.name) {
      return challenge(error.message);
    }
    if (error instanceof Error && error.name === BackofficeExecutionTokenScopeError.name) {
      return apiError("forbidden", error.message);
    }
    throw error;
  }

  // Codemode context handles resolve live user permissions in the workspace they address.
  const execution = createBackofficeUserExecution({ scope, userId: scope.userId });
  const mcp = createMcpHandler(() => {
    const server = new McpServer(
      { name: "leyway", version: "v0" },
      {
        instructions:
          "Read the Codemode guide at leyway://codemode/SYSTEM.md. " +
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
              text: await renderCodemodeSystemPrompt({ state }),
            },
          ],
        };
      },
    );
    server.registerTool(
      "codemode",
      {
        description:
          "Run a JavaScript Codemode function in your personal Leyway workspace. " +
          "Use context.org(organizationId) to call tools in another workspace you can access.",
        inputSchema: backofficeCodemodeInputSchema,
      },
      async (body) => {
        const result = await executeInteractiveCodemode({ body, execution, runtime, kernel });
        return {
          isError: !result.ok,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      },
    );
    return server;
  });
  const response = await mcp.fetch(request);
  response.headers.set("cache-control", "no-store");
  return response;
}
