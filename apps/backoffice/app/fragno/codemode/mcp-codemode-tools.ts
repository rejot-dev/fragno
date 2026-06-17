import { z } from "zod";

import type { ToolProvider } from "@/fragno/codemode/codemode-executor";
import type {
  McpListServersOutput,
  McpRuntime,
  McpTool,
} from "@/fragno/runtime-tools/families/mcp";
import {
  pascalCase,
  renderCodemodeProviderTypes,
  type RuntimeToolReference,
} from "@/fragno/runtime-tools/reference";
import {
  createBackofficeCodemodeProviders,
  type AnyBackofficeRuntimeTool,
  type BackofficeRuntimeToolCall,
} from "@/fragno/runtime-tools/runtime-tools";
import { jsonSchemaToTypeScript, type JsonSchemaObject } from "@/lib/zod/zod-formatter";

export type McpCodemodeTool = {
  originalName: string;
  codemodeName: string;
  description: string;
  inputSchema?: JsonSchemaObject;
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

const isJsonSchemaObject = (value: unknown): value is JsonSchemaObject =>
  !!value && typeof value === "object" && !Array.isArray(value);

const readToolDescription = (tool: McpTool, originalName: string) => {
  const description = typeof tool.description === "string" ? tool.description.trim() : "";
  if (description) {
    return description;
  }

  const title = typeof tool.title === "string" ? tool.title.trim() : "";
  return title || `Call MCP tool ${JSON.stringify(originalName)}.`;
};

export const createMcpCodemodeServers = (servers: readonly McpServerWithCache[]) => {
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
        inputSchema: isJsonSchemaObject(tool.inputSchema) ? tool.inputSchema : undefined,
      });
    }

    if (tools.length) {
      result.push({ slug, providerName, tools });
    }
  }

  return result;
};

const inputTypeNameFor = (server: McpCodemodeServer, tool: McpCodemodeTool) =>
  `Mcp${pascalCase(server.slug) || "Server"}${pascalCase(tool.codemodeName)}Input`;

const outputTypeNameFor = (server: McpCodemodeServer, tool: McpCodemodeTool) =>
  `Mcp${pascalCase(server.slug) || "Server"}${pascalCase(tool.codemodeName)}Output`;

const createMcpCodemodeReferences = (
  servers: readonly McpCodemodeServer[],
): RuntimeToolReference[] =>
  servers.flatMap((server) =>
    server.tools.map((tool) => ({
      id: `mcp.${server.slug}.${tool.originalName}`,
      namespace: server.providerName,
      description: tool.description,
      codemode: {
        providerName: server.providerName,
        toolName: tool.codemodeName,
        description: `${tool.description} MCP server: ${server.slug}; tool: ${tool.originalName}.`,
        inputTypeName: inputTypeNameFor(server, tool),
        outputTypeName: outputTypeNameFor(server, tool),
        inputType: jsonSchemaToTypeScript(tool.inputSchema),
        outputType: "Record<string, unknown>",
      },
      bash: {
        command: "",
        summary: "",
        options: [],
        examples: [],
      },
    })),
  );

export const renderMcpCodemodeProviderTypes = (servers: readonly McpCodemodeServer[]) => {
  if (!servers.length) {
    return "";
  }

  return renderCodemodeProviderTypes(createMcpCodemodeReferences(servers)).replace(
    "// ── Backoffice domain tool providers ───────────────────────────────────",
    "// ── Installed MCP tool providers ───────────────────────────────────────",
  );
};

const createMcpCodemodeRuntimeTools = ({
  runtime,
  servers,
}: {
  runtime: McpRuntime;
  servers: readonly McpCodemodeServer[];
}): AnyBackofficeRuntimeTool[] =>
  servers.flatMap((server) =>
    server.tools.map((tool) => ({
      id: `mcp.${server.slug}.${tool.originalName}`,
      namespace: server.providerName,
      name: tool.codemodeName,
      description: tool.description,
      inputSchema: z.record(z.string(), z.unknown()).optional().default({}),
      outputSchema: z.record(z.string(), z.unknown()),
      execute: async (input) =>
        await runtime.callTool({
          slug: server.slug,
          name: tool.originalName,
          arguments: input as Record<string, unknown>,
        }),
    })),
  );

const isMcpNotConfiguredError = (error: unknown) =>
  error instanceof Error && /MCP is not configured for this organisation\./u.test(error.message);

export const createMcpCodemodeProviders = async ({
  runtime,
  toolCalls,
}: {
  runtime: McpRuntime;
  toolCalls?: BackofficeRuntimeToolCall[];
}): Promise<ToolProvider[]> => {
  let serverList: McpListServersOutput;
  try {
    serverList = await runtime.listServers();
  } catch (error) {
    if (isMcpNotConfiguredError(error)) {
      return [];
    }
    throw error;
  }

  const servers = createMcpCodemodeServers(serverList.servers);
  const tools = createMcpCodemodeRuntimeTools({ runtime, servers });
  return createBackofficeCodemodeProviders({ tools, context: { runtimes: {} }, toolCalls });
};
