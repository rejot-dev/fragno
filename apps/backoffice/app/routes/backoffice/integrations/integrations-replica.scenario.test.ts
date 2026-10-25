import { assert, describe, test, vi } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";

import { eq, or, queryOnce } from "@tanstack/react-db";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { readAutomationReplica } from "@/fragno/automation/lofi/testing";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import {
  integrationConnectionStateChanges,
  integrationEventsQuery,
} from "@/fragno/runtime-tools/families/integrations/integration-connections";

const orgId = "org-1";
const scope = { kind: "org" as const, orgId };
const ENDPOINT_ID = "endpoint-1";

function event(
  id: string,
  source: string,
  eventType: string,
  occurredAt: number,
  { payload, subject }: Pick<AutomationEvent, "payload" | "subject">,
): AutomationEvent {
  return {
    id,
    scopeRestriction: null,
    scope,
    source,
    eventType,
    occurredAt: new Date(occurredAt).toISOString(),
    payload,
    actors: createBackofficeSystemExecution(scope).actors,
    subject,
    causation: { kind: "origin" },
  };
}

function connectionEvent(
  id: string,
  state: "ready" | "unavailable" | "disconnected",
  connectionId: string,
  at: number,
) {
  return event(id, "integrations", `connection.${state}`, at, {
    // Disconnections carry no label.
    payload: state === "disconnected" ? {} : { name: connectionId, authMethod: null },
    subject: { scope, orgId, service: connectionId.split("#", 1)[0], connectionId },
  });
}

function delivery(id: string, endpointId: string, at: number) {
  return event(id, "api", "webhook.received", at, {
    payload: {
      endpointId,
      deliveryId: id,
      hookId: id,
      receivedAt: new Date(at).toISOString(),
      headers: {},
      query: {},
      body: {},
      contentType: null,
    },
    subject: { scope, orgId, endpointId, deliveryId: id },
  });
}

/** The Integrations pages read from the replica what they read from the TanStack collections. */
async function assertIntegrationReadsMatchCollections(ctx: BackofficeScenarioContext) {
  const handle = ctx.lofi.automations.forOrg(orgId);
  const database = ctx.tanstack.automations.forOrg(orgId);
  await Promise.all([handle.drain(), database.drain()]);
  const { replica } = handle;
  const { collections } = database;

  const connections = await queryOnce((query) =>
    query
      .from({ connection: collections.connections })
      .orderBy(({ connection }) => connection.service, "asc")
      .orderBy(({ connection }) => connection.connectionId, "asc"),
  );
  assert.deepEqual(
    await readAutomationReplica(replica, "integrationConnections", undefined),
    connections.map(
      (connection) =>
        Object.fromEntries(
          Object.entries(connection).filter(([key]) => !key.startsWith("$")),
        ) as (typeof connections)[number],
    ),
  );
  assert.deepEqual(
    connections.map(({ connectionId, state }) => `${connectionId}: ${state}`),
    ["api#billing: ready", "mcp#agensi: disconnected", "webhook#orders: unavailable"],
  );

  const changes = integrationConnectionStateChanges(
    await queryOnce((query) => integrationEventsQuery(query, collections)),
  );
  for (const connectionId of ["api#billing", "mcp#agensi", "webhook#orders", "missing"]) {
    assert.deepEqual(
      await readAutomationReplica(replica, "integrationConnectionHistory", { connectionId }),
      changes.filter((change) => change.connectionId === connectionId),
      connectionId,
    );
  }

  for (const endpointId of [ENDPOINT_ID, "endpoint-2", "missing"]) {
    const events = await queryOnce((query) =>
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
    );
    const deliveries = events
      .filter(
        (event) =>
          event.source === endpointId ||
          (event.eventType === "webhook.received" && event.subject?.endpointId === endpointId),
      )
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
      .slice(0, 3)
      .map(({ id, source, eventType, occurredAt }) => ({ id, source, eventType, occurredAt }));
    assert.deepEqual(
      await readAutomationReplica(replica, "webhookDeliveries", { endpointId, limit: 3 }),
      deliveries,
      endpointId,
    );
  }
  // Routed deliveries count under the endpoint, and only the latest three show.
  assert.deepEqual(
    (
      await readAutomationReplica(replica, "webhookDeliveries", {
        endpointId: ENDPOINT_ID,
        limit: 3,
      })
    ).map(({ id }) => id),
    ["raw-3", "raw-2", "routed-1"],
  );
  assert.deepEqual(
    (
      await readAutomationReplica(replica, "integrationConnectionHistory", {
        connectionId: "webhook#orders",
      })
    ).map(({ state }) => state),
    ["unavailable", "ready"],
  );
}

describe("integrations replica", () => {
  test("lists connections, a connection's history, and an endpoint's latest deliveries", async () => {
    const start = Date.now() - 60_000;
    const at = (second: number) => start + second * 1000;

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: allLocalObjects,
        name: "connections change state and a webhook endpoint receives deliveries",
        setup: ({ given }) => [given.organization.exists({ id: orgId, name: "Ada Labs" })],
        steps: ({ when, then }) => [
          when.automation.ingestEvent(
            connectionEvent("billing-ready", "ready", "api#billing", at(1)),
          ),
          when.automation.ingestEvent(
            connectionEvent("agensi-ready", "ready", "mcp#agensi", at(2)),
          ),
          when.automation.ingestEvent(
            connectionEvent("agensi-gone", "disconnected", "mcp#agensi", at(3)),
          ),
          when.automation.ingestEvent(
            connectionEvent("orders-ready", "ready", "webhook#orders", at(4)),
          ),
          when.automation.ingestEvent(
            connectionEvent("orders-down", "unavailable", "webhook#orders", at(5)),
          ),
          when.automation.ingestEvent(delivery("raw-1", ENDPOINT_ID, at(6))),
          when.automation.ingestEvent(delivery("other-1", "endpoint-2", at(7))),
          when.automation.ingestEvent(
            event("routed-1", ENDPOINT_ID, "order.placed", at(8), {
              payload: { id: "routed-1" },
              subject: { orgId },
            }),
          ),
          when.automation.ingestEvent(delivery("raw-2", ENDPOINT_ID, at(9))),
          when.automation.ingestEvent(delivery("raw-3", ENDPOINT_ID, at(10))),
          then.assert("the replica reads what the TanStack collections hold", async (ctx) => {
            await assertIntegrationReadsMatchCollections(ctx);
          }),
        ],
      }),
    );
  });
});
