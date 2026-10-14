import type { IntegrationConnectionDetails } from "@/fragno/runtime-tools/families/integrations/integration-implementation";

import { AutomationDetailRows } from "../automations/detail-rows";
import { DetailSection, describeAuthStatus } from "./connection-display";

export function McpConnectionDetails({
  details: { server, authStatus },
}: {
  details: Extract<IntegrationConnectionDetails, { kind: "mcp" }>;
}) {
  if (server === null) {
    return (
      <DetailSection title="MCP server">
        <p className="px-3 py-2.5 text-xs text-[var(--bo-muted)]">
          No MCP server is registered at this address.
        </p>
      </DetailSection>
    );
  }
  return (
    <>
      <DetailSection title="MCP server">
        <AutomationDetailRows
          layout="inspector"
          rows={[
            { label: "Endpoint", value: server.endpointUrl },
            { label: "Auth", value: describeAuthStatus(authStatus) },
          ]}
        />
      </DetailSection>
      <DetailSection title="Tools">
        {server.tools === null ? (
          <p className="px-3 py-2.5 text-xs text-[var(--bo-muted)]">
            The server&apos;s tools have not been discovered yet.
          </p>
        ) : (
          <ul className="divide-y divide-[color:var(--bo-border)]">
            {server.tools.map((tool) => (
              <li key={tool.name} className="space-y-1 px-3 py-2">
                <p className="font-mono text-[11px] text-[var(--bo-fg)]">{tool.name}</p>
                {tool.description ? (
                  <p className="line-clamp-2 text-xs text-[var(--bo-muted)]">{tool.description}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
    </>
  );
}
