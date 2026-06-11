import { z } from "zod";

import type {
  BackofficeConfigurableConnectionCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createMcpCapabilityFiles } from "@/fragno/backoffice-capabilities/capabilities/mcp-files";

import type { McpAdminConfigResponse } from "../../../../workers/mcp.do";

const optionalTrimmedString = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

export const mcpConfigureInputSchema = z.object({});

const mcpToolSchema = z.object({
  name: z.string().min(1),
  title: optionalTrimmedString,
  description: optionalTrimmedString,
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

const capability = { id: "mcp", label: "MCP", kind: "connection" } as const;
const getMcpDo = (env: CloudflareEnv, orgId: string) => env.MCP.get(env.MCP.idFromName(orgId));

const toMcpStatus = (response: McpAdminConfigResponse): ConnectionStatus => {
  if (!response.configured) {
    return {
      ...capability,
      configured: false,
      missing: ["initialization"],
      nextSteps: ["Initialize MCP for this organisation."],
    };
  }

  return {
    ...capability,
    configured: true,
    config: response.config,
  };
};

export const mcpCapability: BackofficeConfigurableConnectionCapability = {
  ...capability,
  runtimeToolNamespaces: ["mcp"],
  get files() {
    return createMcpCapabilityFiles();
  },
  connection: {
    configurable: true,
    configureInputSchema: mcpConfigureInputSchema,
    configureFields: [],
    getStatus: async ({ env, orgId }) => toMcpStatus(await getMcpDo(env, orgId).getAdminConfig()),
    verify: async ({ env, orgId }) => toMcpStatus(await getMcpDo(env, orgId).getAdminConfig()),
    reset: async ({ env, orgId }) => toMcpStatus(await getMcpDo(env, orgId).resetAdminConfig()),
    configure: async ({ env, orgId, payload }) =>
      toMcpStatus(
        await getMcpDo(env, orgId).setAdminConfig({
          ...mcpConfigureInputSchema.parse(payload),
          orgId,
        }),
      ),
  },
  automationEvents: [],
};

export const mcpToolDescriptorSchema = mcpToolSchema;
