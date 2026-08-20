import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

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

const mcpScopeSubjectSchema = z.object({
  orgId: z.string().min(1).optional(),
  scope: z.unknown().optional(),
});

const mcpServerConfigurationSubjectSchema = mcpScopeSubjectSchema.extend({
  serverId: z.string().min(1),
});

export const mcpCapability: BackofficeCapability = {
  id: "mcp",
  label: "MCP",
  objectBinding: "MCP",
  contributions: {
    connection: null,
    eventSources: [],
    actionProviders: ["mcp"],
    hookScopes: [
      {
        id: "mcp",
        label: "MCP",
        getRepository: ({ objects, scope }) => objects.mcp.for(scope).getDurableHookRepository(),
      },
    ],
    skillPaths: ["skills/mcp-connection/SKILL.md"],
    externalEntities: [],
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
  },
};
