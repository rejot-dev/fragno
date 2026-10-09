import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";

const AUTOMATION_SOURCE = "mcp" as const;
const AUTOMATION_EVENT_SERVER_CONFIGURATION_CHANGED = "server.configuration.changed" as const;
const mcpServerConfigurationChangedPayloadSchema = z.object({
  serverId: z.string().min(1),
  current: z.object({
    tools: z.array(z.unknown()),
  }),
});

const mcpScopeSubjectSchema = z.object({
  orgId: z.string().min(1).optional(),
  scope: z.unknown().optional(),
});

const mcpServerConfigurationSubjectSchema = mcpScopeSubjectSchema.extend({
  serverId: z.string().min(1),
  connectionId: z.string().min(1).describe("Integration address mcp#<slug>."),
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
        getRepository: ({ objects, scope }) =>
          createDurableHookRepositoryFromCommands(objects.mcp.for(scope).commands),
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
    ],
  },
};
