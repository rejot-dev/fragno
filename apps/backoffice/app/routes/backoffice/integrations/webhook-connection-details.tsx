import type { WebhookEndpoint } from "@fragno-dev/api-fragment/types";
import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";

import { useAutomationRead } from "@/fragno/automation/lofi/replica";
import type { IntegrationConnectionDetails } from "@/fragno/runtime-tools/families/integrations/integration-implementation";

import { AutomationDetailRows } from "../automations/detail-rows";
import { DetailSection, formatSourceTimestamp } from "./connection-display";

const RECENT_DELIVERY_COUNT = 10;

export function WebhookConnectionDetails({
  details: { endpoint, publicUrl },
  replica,
}: {
  details: Extract<IntegrationConnectionDetails, { kind: "webhook" }>;
  replica: LofiSqliteClient;
}) {
  if (endpoint === null) {
    return (
      <DetailSection title="Webhook endpoint">
        <p className="px-3 py-2.5 text-xs text-[var(--bo-muted)]">
          No webhook endpoint is stored at this address.
        </p>
      </DetailSection>
    );
  }
  const { lastAcceptedAt, lastRejection } = endpoint.deliveries;
  return (
    <>
      <DetailSection title="Webhook endpoint">
        <AutomationDetailRows
          layout="inspector"
          rows={[
            { label: "URL", value: publicUrl ?? "no public origin configured" },
            { label: "Status", value: endpoint.status },
            { label: "Auth", value: describeWebhookAuth(endpoint.authConfig) },
            { label: "Delivery ID", value: describeDeliveryIdentity(endpoint.deliveryIdentity) },
            {
              label: "Challenge",
              value:
                endpoint.verification.type === "none"
                  ? "none"
                  : `${endpoint.verification.method} challenge, echoed`,
            },
            { label: "Last accepted", value: formatSourceTimestamp(lastAcceptedAt) },
            {
              label: "Last rejected",
              value: lastRejection
                ? `${lastRejection.code} at ${formatSourceTimestamp(lastRejection.receivedAt)}`
                : "—",
            },
          ]}
        />
      </DetailSection>
      <RecentDeliveries endpointId={endpoint.id} replica={replica} />
    </>
  );
}

function RecentDeliveries({
  endpointId,
  replica,
}: {
  endpointId: string;
  replica: LofiSqliteClient;
}) {
  const deliveriesRead = useAutomationRead(replica, "webhookDeliveries", {
    endpointId,
    limit: RECENT_DELIVERY_COUNT,
  });
  const deliveries = deliveriesRead.status === "ready" ? deliveriesRead.data : [];

  return (
    <DetailSection title="Recent deliveries">
      {deliveries.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-[var(--bo-muted)]">
          No delivery has been recorded in this scope.
        </p>
      ) : (
        <ol className="divide-y divide-[color:var(--bo-border)]">
          {deliveries.map((event) => (
            <li key={event.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="truncate font-mono text-[11px] text-[var(--bo-fg)]">
                {event.source}/{event.eventType}
              </span>
              <span className="text-xs whitespace-nowrap text-[var(--bo-muted)]">
                {formatSourceTimestamp(event.occurredAt)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </DetailSection>
  );
}

function describeWebhookAuth(auth: WebhookEndpoint["authConfig"]): string {
  switch (auth.type) {
    case "none":
    case "bearer":
    case "basic":
      return auth.type;
    case "apiKey":
      return `API key in ${auth.location} ${auth.name}`;
    case "hmac":
      return `HMAC-${auth.algorithm.toUpperCase()}, ${auth.signature.encoding} in ${auth.signature.location} ${auth.signature.name}`;
    default:
      throw new Error("Webhook auth type is unsupported.", { cause: auth satisfies never });
  }
}

function describeDeliveryIdentity(identity: WebhookEndpoint["deliveryIdentity"]): string {
  switch (identity.type) {
    case "header":
    case "query":
      return `${identity.type} ${identity.name}`;
    case "jsonBodyPath":
      return `body $.${identity.path.join(".")}`;
    default:
      throw new Error("Webhook delivery identity is unsupported.", {
        cause: identity satisfies never,
      });
  }
}
