import type { ApiAuthStatus } from "@fragno-dev/api-fragment/types";
import type { IntegrationAuthMethod } from "@fragno-dev/backoffice-api/v0/integrations";
import type { McpAuthStatus } from "@fragno-dev/mcp-fragment/types";
import {
  BackofficeStatusLight,
  type BackofficeStatusTone,
} from "@fragno-private/design-system/status-light";
import type { ReactNode } from "react";

import { formatTimestamp } from "../automations/formatting";
import type { IntegrationConnectionStateChange } from "./connection-overview";

const stateLights = {
  ready: { label: "Ready", tone: "live" },
  unavailable: { label: "Unavailable", tone: "waiting" },
  disconnected: { label: "Disconnected", tone: "muted" },
} as const satisfies Record<
  IntegrationConnectionStateChange["state"],
  { label: string; tone: BackofficeStatusTone }
>;

export function IntegrationConnectionStateLight({
  state,
}: {
  state: IntegrationConnectionStateChange["state"];
}) {
  const light = stateLights[state];
  return (
    <BackofficeStatusLight tone={light.tone} dot={false}>
      {light.label}
    </BackofficeStatusLight>
  );
}

export const integrationConnectionKindLabels = {
  api: "API",
  webhook: "Webhook",
  mcp: "MCP",
  connector: "Connector",
  native: "Native",
} as const satisfies Record<IntegrationConnectionStateChange["kind"], string>;

/** A titled block of the connection detail panel. */
export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border border-[color:var(--bo-border)]">
      <h3 className="border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function describeAuthStatus(status: ApiAuthStatus | McpAuthStatus | null): string {
  if (status === null) {
    return "—";
  }
  switch (status.mode) {
    case "none":
      return "none required";
    case "oauth":
      return `OAuth, ${status.state}`;
    case "bearer":
    case "basic":
    case "client_credentials":
      return `${status.mode}, credentials ${status.credentials}`;
    default:
      throw new Error("Auth status mode is unsupported.", { cause: status satisfies never });
  }
}

/** Fragment timestamps arrive as strings or dates depending on the route serializer. */
export function formatSourceTimestamp(value: string | Date | null | undefined) {
  return value ? formatTimestamp(value) : "—";
}

export const integrationAuthMethodLabels = {
  none: "None",
  "api-key": "API key",
  bearer: "Bearer token",
  basic: "Basic",
  "client-credentials": "Client credentials",
  oauth: "OAuth",
  signature: "Signature",
  "app-installation": "App installation",
} as const satisfies Record<IntegrationAuthMethod, string>;

/** API, webhook, and MCP addresses are their own names; other kinds also name the service. */
export function describeIntegrationConnectionKind(
  change: Pick<IntegrationConnectionStateChange, "kind" | "service">,
) {
  const label = integrationConnectionKindLabels[change.kind];
  return change.kind === "connector" || change.kind === "native"
    ? `${label} · ${change.service}`
    : label;
}

/**
 * The name the connection's events carry. Without one, connector addresses are opaque encodings
 * and native slots are named after their service, so both fall back to the service.
 */
export function integrationConnectionName(
  change: Pick<IntegrationConnectionStateChange, "connectionId" | "kind" | "service" | "label">,
) {
  if (change.label !== null) {
    return change.label.name;
  }
  const [namespace, localId] = splitConnectionId(change.connectionId);
  return change.kind === "connector" || namespace === "backoffice" ? change.service : localId;
}

function splitConnectionId(connectionId: string) {
  const separator = connectionId.indexOf("#");
  return [connectionId.slice(0, separator), connectionId.slice(separator + 1)] as const;
}
