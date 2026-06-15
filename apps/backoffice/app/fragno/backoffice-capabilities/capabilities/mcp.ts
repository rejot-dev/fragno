import { z } from "zod";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type {
  BackofficeConfigurableConnectionCapability,
  ConnectionStatus,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createMcpCapabilityFiles } from "@/fragno/backoffice-capabilities/capabilities/mcp-files";

import type { McpAdminConfigResponse } from "../../../../workers/mcp.do";

export const mcpConfigureInputSchema = z.object({});

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
const getMcpDo = (objects: BackofficeObjectRegistry, orgId: string) => objects.mcp.forOrg(orgId);

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
    getStatus: async ({ objects, orgId }) =>
      toMcpStatus(await getMcpDo(objects, orgId).getAdminConfig()),
    verify: async ({ objects, orgId }) =>
      toMcpStatus(await getMcpDo(objects, orgId).getAdminConfig()),
    reset: async ({ objects, orgId }) =>
      toMcpStatus(await getMcpDo(objects, orgId).resetAdminConfig()),
    configure: async ({ objects, orgId, payload }) =>
      toMcpStatus(
        await getMcpDo(objects, orgId).setAdminConfig({
          ...mcpConfigureInputSchema.parse(payload),
          orgId,
        }),
      ),
  },
  hooks: [
    {
      id: "mcp",
      label: "MCP",
      getRepository: ({ objects, orgId }) => getMcpDo(objects, orgId).getDurableHookRepository(),
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
