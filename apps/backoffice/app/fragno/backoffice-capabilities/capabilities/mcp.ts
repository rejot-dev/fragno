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

const AUTOMATION_SOURCE = "mcp" as const;
const AUTOMATION_EVENT_SERVER_CONFIGURATION_CHANGED = "server.configuration.changed" as const;
const AUTOMATION_EVENT_SERVER_CONFIGURATION_DELETED = "server.configuration.deleted" as const;

const mcpServerConfigurationChangedPayloadSchema = z.object({
  serverId: z.string().min(1),
  current: z.object({
    tools: z.array(z.unknown()),
  }),
});

const mcpServerConfigurationDeletedPayloadSchema = z.object({
  serverId: z.string().min(1),
});

const mcpServerConfigurationSubjectSchema = z.object({
  orgId: z.string().min(1),
  serverId: z.string().min(1),
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
  hooks: [
    {
      id: "mcp",
      label: "MCP",
      getRepository: ({ env, orgId }) => getMcpDo(env, orgId).getDurableHookRepository(),
    },
  ],
  automationEvents: [
    {
      source: AUTOMATION_SOURCE,
      eventType: AUTOMATION_EVENT_SERVER_CONFIGURATION_CHANGED,
      label: "MCP server configuration changed",
      description: "Fires when an MCP server's refreshed configuration meaningfully changes.",
      payloadSchema: mcpServerConfigurationChangedPayloadSchema,
      subjectSchema: mcpServerConfigurationSubjectSchema,
      example: {
        serverId: "local-tools",
        current: { tools: [{ name: "new-tool" }] },
      },
    },
    {
      source: AUTOMATION_SOURCE,
      eventType: AUTOMATION_EVENT_SERVER_CONFIGURATION_DELETED,
      label: "MCP server configuration deleted",
      description: "Fires when an MCP server configuration is deleted.",
      payloadSchema: mcpServerConfigurationDeletedPayloadSchema,
      subjectSchema: mcpServerConfigurationSubjectSchema,
      example: {
        serverId: "local-tools",
      },
    },
  ],
};

export const mcpToolDescriptorSchema = mcpToolSchema;
