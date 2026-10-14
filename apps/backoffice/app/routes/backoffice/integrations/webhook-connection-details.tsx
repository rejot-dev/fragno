import type { WebhookEndpoint } from "@fragno-dev/api-fragment/types";

import { eq, or, useLiveQuery } from "@tanstack/react-db";

import type { IntegrationConnectionDetails } from "@/fragno/runtime-tools/families/integrations/integration-implementation";

import { AutomationDetailRows } from "../automations/detail-rows";
import { DetailSection, formatSourceTimestamp } from "./connection-display";
import type { IntegrationsLayoutContext } from "./layout-context";

const RECENT_DELIVERY_COUNT = 10;

export function WebhookConnectionDetails({
  details: { endpoint, publicUrl },
  collections,
}: {
  details: Extract<IntegrationConnectionDetails, { kind: "webhook" }>;
  collections: IntegrationsLayoutContext["collections"];
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
      <RecentDeliveries endpointId={endpoint.id} collections={collections} />
    </>
  );
}

/** Raw deliveries arrive as api/webhook.received; routes reclassify them under the endpoint ID. */
function RecentDeliveries({
  endpointId,
  collections,
}: {
  endpointId: string;
  collections: IntegrationsLayoutContext["collections"];
}) {
  const eventsQuery = useLiveQuery(
    (query) =>
      query
        .from({ event: collections.events })
        .where(({ event }) => or(eq(event.source, "api"), eq(event.source, endpointId)))
        .select(({ event }) => ({
          id: event.id,
          source: event.source,
          eventType: event.eventType,
          subject: event.subject,
          occurredAt: event.occurredAt,
        })),
    [collections.events, endpointId],
  );
  const deliveries = (eventsQuery.data ?? [])
    .filter(
      (event) =>
        event.source === endpointId ||
        (event.eventType === "webhook.received" && event.subject?.endpointId === endpointId),
    )
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
    .slice(0, RECENT_DELIVERY_COUNT);

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
