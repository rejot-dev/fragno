import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { ToolProvider } from "@fragno-dev/codemode/runtime-api";
import type { McpTool } from "@fragno-dev/mcp-fragment/types";
import { z } from "zod";

import { BackofficeForbiddenError, isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { encodeMcpConnectionId } from "@/fragno/runtime-tools/families/integrations/mcp-integration";
import type { McpListServersOutput, McpRuntime } from "@/fragno/runtime-tools/families/mcp-runtime";
import { pascalCase, type RuntimeToolReference } from "@/fragno/runtime-tools/reference";
import { NotConfiguredError } from "@/fragno/runtime-tools/runtime-errors";
import {
  createBackofficeCodemodeProviders,
  type AnyBackofficeRuntimeTool,
  defineBackofficeRuntimeTool,
  type BackofficeRuntimeToolCall,
  type BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";
import {
  jsonSchemaToTypeScriptRender,
  type JsonSchemaObject,
  type JsonSchemaTypeScriptRender,
} from "@/lib/zod/zod-formatter";

export type McpCodemodeTool = {
  originalName: string;
  codemodeName: string;
  description: string;
  inputSchema: JsonSchemaObject;
  outputSchema: JsonSchemaObject | undefined;
};

export type McpCodemodeServer = {
  slug: string;
  providerName: string;
  tools: McpCodemodeTool[];
};

type McpServerWithCache = McpListServersOutput["servers"][number];

const RESERVED_CODEMODE_NAMES = new Set([
  "abstract",
  "arguments",
  "await",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "constructor",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "double",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "float",
  "for",
  "function",
  "goto",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "int",
  "interface",
  "let",
  "long",
  "native",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "prototype",
  "public",
  "return",
  "short",
  "static",
  "super",
  "switch",
  "synchronized",
  "then",
  "this",
  "throw",
  "throws",
  "transient",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "volatile",
  "while",
  "with",
  "yield",
  "__proto__",
]);

const sanitizeMcpCodemodeName = (name: string) => {
  const sanitized = name
    .trim()
    .replace(/[-.\s]/g, "_")
    .replace(/[^a-zA-Z0-9_$]/g, "");
  const identifier = /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized || "_";
  return RESERVED_CODEMODE_NAMES.has(identifier) ? `${identifier}_` : identifier;
};

const mcpCodemodeProviderNameForSlug = (slug: string) => `mcp_${sanitizeMcpCodemodeName(slug)}`;

function readToolDescription(tool: McpTool, originalName: string) {
  const description = tool.description?.trim() ?? "";
  if (description) {
    return description;
  }

  const title = tool.title?.trim() ?? "";
  return title || `Call MCP tool ${JSON.stringify(originalName)}.`;
}

export function createMcpCodemodeServers(servers: readonly McpServerWithCache[]) {
  const result: McpCodemodeServer[] = [];
  const usedProviders = new Set<string>();

  for (const server of servers) {
    const slug = server.slug.trim();
    if (!slug) {
      continue;
    }

    const providerName = mcpCodemodeProviderNameForSlug(slug);
    if (usedProviders.has(providerName)) {
      continue;
    }
    usedProviders.add(providerName);

    const cachedTools = server.cache?.tools ?? [];
    const usedMethods = new Set<string>();
    const tools: McpCodemodeTool[] = [];

    for (const tool of cachedTools) {
      const originalName = tool.name.trim();
      if (!originalName) {
        continue;
      }

      const codemodeName = sanitizeMcpCodemodeName(originalName);
      if (usedMethods.has(codemodeName)) {
        continue;
      }
      usedMethods.add(codemodeName);

      tools.push({
        originalName,
        codemodeName,
        description: readToolDescription(tool, originalName),
        inputSchema: tool.inputSchema as JsonSchemaObject,
        outputSchema: tool.outputSchema as JsonSchemaObject | undefined,
      });
    }

    if (tools.length) {
      result.push({ slug, providerName, tools });
    }
  }

  return result;
}

const inputTypeNameFor = (server: McpCodemodeServer, tool: McpCodemodeTool) =>
  `Mcp${pascalCase(server.slug) || "Server"}${pascalCase(tool.codemodeName)}Input`;

const outputTypeNameFor = (server: McpCodemodeServer, tool: McpCodemodeTool) =>
  `Mcp${pascalCase(server.slug) || "Server"}${pascalCase(tool.codemodeName)}Output`;

function renderMcpSchemaType(
  schema: JsonSchemaObject,
  namespace: string,
): JsonSchemaTypeScriptRender {
  const rendered = jsonSchemaToTypeScriptRender(schema, { rootTypeName: "Value" });
  // Remote tools can reuse $defs names; each schema needs its own declaration scope.
  const body = [...rendered.declarations, `export type Value = ${rendered.type};`]
    .join("\n")
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return {
    type: `${namespace}.Value`,
    declarations: [`declare namespace ${namespace} {\n${body}\n}`],
  };
}

export function createMcpCodemodeReferences(
  servers: readonly McpCodemodeServer[],
): RuntimeToolReference[] {
  return servers.flatMap((server) =>
    server.tools.map((tool) => {
      const inputTypeName = inputTypeNameFor(server, tool);
      const outputTypeName = outputTypeNameFor(server, tool);
      const input = renderMcpSchemaType(tool.inputSchema, `${inputTypeName}Schema`);
      const output =
        tool.outputSchema === undefined
          ? null
          : renderMcpSchemaType(tool.outputSchema, `${outputTypeName}Schema`);
      return {
        id: `mcp.${server.slug}.${tool.originalName}`,
        namespace: server.providerName,
        description: tool.description,
        codemode: {
          providerName: server.providerName,
          toolName: tool.codemodeName,
          description: `${tool.description} Connection ${encodeMcpConnectionId(server.slug)}; tool: ${tool.originalName}.`,
          inputTypeName,
          outputTypeName,
          inputType: input.type,
          inputTypeDeclarations: input.declarations,
          // MCP outputSchema describes structuredContent, not the entire tool-call result.
          outputType: output
            ? `Record<string, unknown> & { structuredContent: ${output.type} }`
            : "Record<string, unknown>",
          outputTypeDeclarations: output?.declarations ?? [],
        },
        bash: {
          command: "",
          summary: "",
          options: [],
          examples: [],
        },
      };
    }),
  );
}

const createMcpCodemodeRuntimeTools = ({
  runtime,
  servers,
}: {
  runtime: McpRuntime;
  servers: readonly McpCodemodeServer[];
}): AnyBackofficeRuntimeTool[] =>
  servers.flatMap((server) =>
    server.tools.map((tool) =>
      defineBackofficeRuntimeTool({
        id: `mcp.${server.slug}.${tool.originalName}`,
        namespace: server.providerName,
        name: tool.codemodeName,
        description: tool.description,
        requiredPermissions: [BACKOFFICE_PERMISSION.integrations.execute],
        getResource: () => ({ slug: server.slug, toolName: tool.originalName }),
        inputSchema: z.record(z.string(), z.unknown()).optional().default({}),
        outputSchema: z.record(z.string(), z.unknown()),
        execute: async (input) =>
          await runtime.callTool({
            slug: server.slug,
            name: tool.originalName,
            arguments: input,
          }),
      }),
    ),
  );

export async function createMcpCodemodeProviders({
  runtime,
  context,
  toolCalls,
}: {
  runtime: McpRuntime;
  context: BackofficeToolContext;
  toolCalls?: BackofficeRuntimeToolCall[];
}): Promise<{ providers: ToolProvider[]; discoveryError: Error | null }> {
  let serverList: McpListServersOutput;
  try {
    serverList = await runtime.listServers();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return { providers: [], discoveryError: error };
    }
    if (isBackofficeForbiddenError(error) && error.reason !== "authority-unavailable") {
      return {
        providers: [],
        discoveryError: new BackofficeForbiddenError(
          [
            "Cannot discover generated MCP providers.",
            "Required permission: connections.read.",
            "Calling MCP tools also requires integrations.execute.",
            `Reason: ${error.message}`,
          ].join("\n"),
          error.reason,
        ),
      };
    }
    throw error;
  }

  const servers = createMcpCodemodeServers(serverList.servers);
  const tools = createMcpCodemodeRuntimeTools({ runtime, servers });
  return {
    providers: createBackofficeCodemodeProviders({ tools, context, toolCalls }),
    discoveryError: null,
  };
}

export function explainMcpCodemodeError(discoveryError: Error | null, error: string): string;
export function explainMcpCodemodeError(discoveryError: Error | null, error: unknown): unknown;
export function explainMcpCodemodeError(discoveryError: Error | null, error: unknown): unknown {
  const message =
    typeof error === "string"
      ? error
      : error !== null && typeof error === "object" && "message" in error
        ? error.message
        : null;

  // Discovery must not block non-MCP execution or replace unrelated script failures.
  // Only explain a missing generated provider; no undiscovered server metadata is needed.
  if (
    discoveryError &&
    typeof message === "string" &&
    /^mcp_[a-zA-Z0-9_$]+ is not defined$/u.test(message)
  ) {
    return typeof error === "string" ? discoveryError.message : discoveryError;
  }
  return error;
}
