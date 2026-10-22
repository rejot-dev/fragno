import type { ApiAuthStatus } from "@fragno-dev/api-fragment/types";
import type { IntegrationAuthMethod } from "@fragno-dev/backoffice-api/v0/integrations";
import type { McpAuthStatus } from "@fragno-dev/mcp-fragment/types";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import type { BackofficeStatusTone } from "@fragno-private/design-system/status-tone";
import type { ReactNode } from "react";

import type { IntegrationConnectionRecord } from "@/fragno/runtime-tools/families/integrations/integration-connections";

import { formatTimestamp } from "../automations/formatting";

const stateLights = {
  ready: { label: "Ready", tone: "live" },
  unavailable: { label: "Unavailable", tone: "waiting" },
  disconnected: { label: "Disconnected", tone: "muted" },
} as const satisfies Record<
  IntegrationConnectionRecord["state"],
  { label: string; tone: BackofficeStatusTone }
>;

export function IntegrationConnectionStateLight({
  state,
}: {
  state: IntegrationConnectionRecord["state"];
}) {
  const light = stateLights[state];
  return (
    <BackofficeStatusLight tone={light.tone} dot={false}>
      {light.label}
    </BackofficeStatusLight>
  );
}

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
