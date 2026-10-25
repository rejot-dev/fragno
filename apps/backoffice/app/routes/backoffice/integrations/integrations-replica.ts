import { lofiSqliteTableName, type LofiSqliteReader } from "@fragno-dev/lofi/sqlite";

import { automationFragmentSchema } from "@/fragno/automation/schema";
import {
  integrationConnectionStateChanges,
  type IntegrationConnectionStateChange,
} from "@/fragno/runtime-tools/families/integrations/integration-connections";
import { INTEGRATIONS_EVENT_SOURCE } from "@/fragno/runtime-tools/families/integrations/integration-events";

const event = automationFragmentSchema.tables.automation_event;
const eventTable = `"${lofiSqliteTableName({ schema: automationFragmentSchema }, "automation_event")}"`;

/** The state changes a connection's events report, newest first. */
export function readIntegrationConnectionHistory(
  reader: LofiSqliteReader,
  { connectionId }: { connectionId: string },
): IntegrationConnectionStateChange[] {
  const columns = event.columns;
  const events = reader.query({
    // Narrows by the subject's connection; `integrationConnectionStateChanges` validates it.
    sql: `SELECT "id", "source", "eventType", "payload", "subject", "occurredAt"
          FROM ${eventTable}
          WHERE "source" = ? AND json_extract("subject", '$.connectionId') = ?`,
    params: [INTEGRATIONS_EVENT_SOURCE, connectionId],
    columns: {
      id: "text",
      source: columns.source,
      eventType: columns.eventType,
      payload: columns.payload,
      subject: columns.subject,
      occurredAt: columns.occurredAt,
    },
  });
  return integrationConnectionStateChanges(events).filter(
    (change) => change.connectionId === connectionId,
  );
}

/**
 * A webhook endpoint's latest deliveries, newest first. Raw deliveries arrive as
 * api/webhook.received with the endpoint in their subject; routes reclassify them under the
 * endpoint ID as their source.
 */
export function readWebhookDeliveries(
  reader: LofiSqliteReader,
  { endpointId, limit }: { endpointId: string; limit: number },
) {
  const columns = {
    id: "text",
    source: event.columns.source,
    eventType: event.columns.eventType,
    occurredAt: event.columns.occurredAt,
  } as const;
  const select = `SELECT "id", "source", "eventType", "occurredAt" FROM ${eventTable}`;
  const order = `ORDER BY "occurredAt" DESC, "id" DESC LIMIT ?`;
  const reclassified = reader.query({
    sql: `${select} WHERE "source" = ? ${order}`,
    params: [endpointId, limit],
    columns,
  });
  const received = reader.query({
    sql: `${select}
          WHERE "source" = 'api' AND "eventType" = 'webhook.received'
            AND json_extract("subject", '$.endpointId') = ?
          ${order}`,
    params: [endpointId, limit],
    columns,
  });
  return [...reclassified, ...received]
    .sort(
      (left, right) =>
        right.occurredAt.getTime() - left.occurredAt.getTime() ||
        (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
    )
    .slice(0, limit);
}
