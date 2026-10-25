import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";
import { lofiSqliteTableName, type LofiSqliteReader } from "@fragno-dev/lofi/sqlite";

import {
  defineLocalProjection,
  type AnyLofiLocalProjection,
  type LofiMutationMatcher,
  type LofiSchemaRegistration,
} from "@fragno-dev/lofi";

import {
  readPiAgentEvent,
  type PiAgentActivityKind,
  type PiAgentEvent,
} from "@/fragno/backoffice-capabilities/capabilities/pi";
import { BUILT_IN_PI_AGENT_DEFINITIONS } from "@/fragno/pi/agent/agent-definitions";
import {
  applyPiAgentEvent,
  piAgentEventRequestId,
  piAgentRecord,
  piAgentRequestKey,
  piAgentTurnEndedBy,
  type PiAgentRecord,
  type PiAgentRequestState,
  type PiAgentState,
  type PiAgentTurnRecord,
} from "@/fragno/pi/agent/pi-agent-records";
import {
  applyIntegrationConnectionChange,
  integrationConnectionRecord,
  readIntegrationConnectionStateChange,
  type IntegrationConnectionFold,
  type IntegrationConnectionKind,
  type IntegrationConnectionRecord,
  type IntegrationConnectionStateChange,
} from "@/fragno/runtime-tools/families/integrations/integration-connections";
import type { IntegrationConnectionLabel } from "@/fragno/runtime-tools/families/integrations/integration-events";

import { automationFragmentSchema } from "../schema";

const jsonColumn = <T>() => column("json") as Column<"json", T, T>;

/**
 * What Backoffice derives from the scope's events, kept up to date by the projections below with
 * the same functions the TanStack collections derive it with. The replica's database is named by
 * this schema's version, not by the projections' code: when a projection changes what it writes,
 * add an operation, such as `.noOp(...)`, so replicas replay their outbox into a new database.
 */
export const automationViewsSchema = schema("automation_views", (s) =>
  s
    // Keyed by agent name: every agent with events, as `PiAgentState` records it.
    .addTable("pi_agent", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("latestKind", column("string"))
        .addColumn("latestAt", column("timestamp"))
        .addColumn("latestCreatedAt", column("timestamp"))
        // Null without a definition event, and after a deletion.
        .addColumn("definition", jsonColumn<PiAgentDefinition>().nullable())
        .addColumn("definitionAt", column("timestamp").nullable())
        .addColumn("definitionCreatedAt", column("timestamp").nullable())
        .addColumn("paused", column("bool").nullable())
        .addColumn("pauseAt", column("timestamp").nullable())
        .addColumn("pauseCreatedAt", column("timestamp").nullable())
        .addColumn("running", column("integer"))
        .addColumn("queued", column("integer"))
        .addColumn("steering", column("integer")),
    )
    // Keyed by `piAgentRequestKey`, so an agent's counts change by what one event did.
    .addTable("pi_agent_request", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("started", column("bool"))
        .addColumn("ended", column("bool"))
        .addColumn("waiting", column("bool"))
        .addColumn("steer", column("bool"))
        .addColumn("dequeued", column("bool")),
    )
    // Keyed by the event that ended the turn.
    .addTable("pi_agent_turn", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("agentName", column("string"))
        .addColumn("outcome", column("string"))
        .addColumn("endedAt", column("timestamp"))
        .createIndex("idx_pi_agent_turn_endedAt", ["endedAt"]),
    )
    // Keyed by connection ID. `name` and `authMethod` are the latest label's, from `labelAt`.
    .addTable("integration_connection", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("service", column("string"))
        .addColumn("kind", column("string"))
        .addColumn("state", column("string"))
        .addColumn("eventId", column("string"))
        .addColumn("changedAt", column("timestamp"))
        .addColumn("name", column("string").nullable())
        .addColumn("authMethod", column("string").nullable())
        .addColumn("labelAt", column("timestamp").nullable())
        .addColumn("displayName", column("string"))
        .addColumn("kindLabel", column("string")),
    ),
);

const views = automationViewsSchema.tables;

type PiAgentRow = {
  latestKind: string;
  latestAt: Date;
  latestCreatedAt: Date;
  definition: PiAgentDefinition | null;
  definitionAt: Date | null;
  definitionCreatedAt: Date | null;
  paused: boolean | null;
  pauseAt: Date | null;
  pauseCreatedAt: Date | null;
  running: number;
  queued: number;
  steering: number;
};

function piAgentState(row: PiAgentRow): PiAgentState {
  return {
    // Only the projection writes these rows, from `PiAgentState`.
    latest: {
      kind: row.latestKind as PiAgentActivityKind,
      occurredAt: row.latestAt,
      createdAt: row.latestCreatedAt,
    },
    definition:
      row.definitionAt === null || row.definitionCreatedAt === null
        ? null
        : {
            definition: row.definition,
            occurredAt: row.definitionAt,
            createdAt: row.definitionCreatedAt,
          },
    pause:
      row.paused === null || row.pauseAt === null || row.pauseCreatedAt === null
        ? null
        : { paused: row.paused, occurredAt: row.pauseAt, createdAt: row.pauseCreatedAt },
    running: row.running,
    queued: row.queued,
    steering: row.steering,
  };
}

function piAgentRow(agent: PiAgentState): PiAgentRow {
  return {
    latestKind: agent.latest.kind,
    latestAt: agent.latest.occurredAt,
    latestCreatedAt: agent.latest.createdAt,
    definition: agent.definition?.definition ?? null,
    definitionAt: agent.definition?.occurredAt ?? null,
    definitionCreatedAt: agent.definition?.createdAt ?? null,
    paused: agent.pause?.paused ?? null,
    pauseAt: agent.pause?.occurredAt ?? null,
    pauseCreatedAt: agent.pause?.createdAt ?? null,
    running: agent.running,
    queued: agent.queued,
    steering: agent.steering,
  };
}

/** The events an outbox entry stores. Stored events change only in what these views do not read. */
function createdEvents(match: LofiMutationMatcher) {
  return match.all(automationFragmentSchema, "automation_event", "create").map((mutation) => ({
    id: mutation.externalId,
    source: mutation.values.source,
    eventType: mutation.values.eventType,
    payload: mutation.values.payload,
    subject: mutation.values.subject ?? null,
    // The replica decodes outbox dates and resolves `now()` before projections run.
    occurredAt: mutation.values.occurredAt as Date,
    createdAt: mutation.values.createdAt as Date,
  }));
}

type PiEvent = ReturnType<typeof createdEvents>[number] & { read: PiAgentEvent };

type EntryEvents = {
  pi: PiEvent[];
  connectionChanges: IntegrationConnectionStateChange[];
};

// Every projection's `retrieve` and `mutate` get the same matcher for an entry, so each event is
// validated once per entry rather than once per call.
const entryEvents = new WeakMap<LofiMutationMatcher, EntryEvents>();

/**
 * What the entry's events mean to these views. Neither kind is ever deleted: `admin.events.delete`
 * refuses `pi` and `integrations` events, which is what lets the projections fold them as they
 * arrive instead of deriving rows from the events that remain.
 */
function eventsOf(match: LofiMutationMatcher): EntryEvents {
  const cached = entryEvents.get(match);
  if (cached) {
    return cached;
  }
  const created = createdEvents(match);
  const events: EntryEvents = {
    pi: created.flatMap((event) => {
      const read = readPiAgentEvent(event);
      return read ? [{ ...event, read }] : [];
    }),
    connectionChanges: created.flatMap(
      (event) => readIntegrationConnectionStateChange(event) ?? [],
    ),
  };
  entryEvents.set(match, events);
  return events;
}

function requestKeyOf({ read }: PiEvent): string | null {
  const requestId = piAgentEventRequestId(read);
  return requestId === null ? null : piAgentRequestKey(read.agentName, requestId);
}

/** Agents and their requests, by `applyPiAgentEvent`, and the turns their events ended. */
const piAgents = defineLocalProjection({
  name: "pi-agents",
  retrieve: ({ match, read }) => {
    const events = eventsOf(match).pi;
    if (events.length === 0) {
      return undefined;
    }
    const requestKeys = events.flatMap((event) => requestKeyOf(event) ?? []);
    return {
      agents: read.getEach(
        [...new Set(events.map(({ read }) => read.agentName))],
        automationViewsSchema,
        "pi_agent",
        (agentName) => agentName,
      ),
      requests: read.getEach(
        [...new Set(requestKeys)],
        automationViewsSchema,
        "pi_agent_request",
        (requestKey) => requestKey,
      ),
    };
  },
  mutate: ({ match, retrieved, tx }) => {
    if (!retrieved) {
      return;
    }
    const views = tx.forSchema(automationViewsSchema);

    const agents = new Map(
      retrieved.agents.map(({ item, row }) => [item, row ? piAgentState(row) : null]),
    );
    const requests = new Map<string, PiAgentRequestState | null>(
      retrieved.requests.map(({ item, row }) => [
        item,
        row
          ? {
              started: row.started,
              ended: row.ended,
              waiting: row.waiting,
              steer: row.steer,
              dequeued: row.dequeued,
            }
          : null,
      ]),
    );
    for (const event of eventsOf(match).pi) {
      const requestKey = requestKeyOf(event);
      const applied = applyPiAgentEvent(
        agents.get(event.read.agentName) ?? null,
        requestKey === null ? null : (requests.get(requestKey) ?? null),
        event.read,
        event,
      );
      agents.set(event.read.agentName, applied.agent);
      if (requestKey !== null) {
        requests.set(requestKey, applied.request);
      }
      const turn = piAgentTurnEndedBy(event, event.read);
      if (turn) {
        views.create("pi_agent_turn", turn);
      }
    }

    // `create` merges into an existing row.
    for (const [agentName, agent] of agents) {
      if (agent) {
        views.create("pi_agent", { id: agentName, ...piAgentRow(agent) });
      }
    }
    for (const [requestKey, request] of requests) {
      if (request) {
        views.create("pi_agent_request", { id: requestKey, ...request });
      }
    }
  },
});

/** Connections, by `applyIntegrationConnectionChange`. */
const integrationConnections = defineLocalProjection({
  name: "integration-connections",
  retrieve: ({ match, read }) => {
    const changes = eventsOf(match).connectionChanges;
    return changes.length === 0
      ? undefined
      : read.getEach(
          [...new Set(changes.map(({ connectionId }) => connectionId))],
          automationViewsSchema,
          "integration_connection",
          (connectionId) => connectionId,
        );
  },
  mutate: ({ match, retrieved, tx }) => {
    if (!retrieved) {
      return;
    }
    const connections = new Map(
      retrieved.map(({ item, row }): [string, IntegrationConnectionFold | null] => {
        if (!row) {
          return [item, null];
        }
        const label: IntegrationConnectionLabel | null =
          row.labelAt === null
            ? null
            : {
                name: row.name!,
                authMethod: row.authMethod as IntegrationConnectionLabel["authMethod"],
              };
        // Only the projection writes these rows, from `IntegrationConnectionFold`. Folding reads
        // when the latest change happened, not its own label.
        const latest: IntegrationConnectionStateChange = {
          eventId: row.eventId,
          connectionId: item,
          service: row.service,
          kind: row.kind as IntegrationConnectionKind,
          state: row.state as IntegrationConnectionStateChange["state"],
          label,
          occurredAt: row.changedAt,
        };
        return [item, { latest, label, labelAt: row.labelAt }];
      }),
    );
    for (const change of eventsOf(match).connectionChanges) {
      connections.set(
        change.connectionId,
        applyIntegrationConnectionChange(connections.get(change.connectionId) ?? null, change),
      );
    }

    const views = tx.forSchema(automationViewsSchema);
    for (const [connectionId, connection] of connections) {
      if (!connection) {
        continue;
      }
      const record = integrationConnectionRecord(connection);
      views.create("integration_connection", {
        id: connectionId,
        service: record.service,
        kind: record.kind,
        state: record.state,
        eventId: record.eventId,
        changedAt: record.changedAt,
        name: record.name,
        authMethod: record.authMethod,
        labelAt: connection.labelAt,
        displayName: record.displayName,
        kindLabel: record.kindLabel,
      });
    }
  },
});

/** The local schema and projections every Automations replica keeps. */
export const automationViews: {
  localSchemas: LofiSchemaRegistration[];
  projections: AnyLofiLocalProjection[];
} = {
  localSchemas: [{ schema: automationViewsSchema }],
  projections: [piAgents, integrationConnections],
};

const table = (name: keyof typeof views) =>
  `"${lofiSqliteTableName({ schema: automationViewsSchema }, name)}"`;

/**
 * The scope's agents: built-in agents, and those their events define. The most recently active
 * come first; agents without activity keep built-in agents first, then go by name.
 */
export function readPiAgents(reader: LofiSqliteReader): PiAgentRecord[] {
  const agent = views.pi_agent.columns;
  const rows = reader.query({
    sql: `SELECT "id" AS "agentName", "latestKind", "latestAt", "latestCreatedAt", "definition",
            "definitionAt", "definitionCreatedAt", "paused", "pauseAt", "pauseCreatedAt", "running",
            "queued", "steering"
          FROM ${table("pi_agent")}`,
    params: [],
    columns: {
      agentName: "text",
      latestKind: agent.latestKind,
      latestAt: agent.latestAt,
      latestCreatedAt: agent.latestCreatedAt,
      definition: agent.definition,
      definitionAt: agent.definitionAt,
      definitionCreatedAt: agent.definitionCreatedAt,
      paused: agent.paused,
      pauseAt: agent.pauseAt,
      pauseCreatedAt: agent.pauseCreatedAt,
      running: agent.running,
      queued: agent.queued,
      steering: agent.steering,
    },
  });
  const states = new Map(rows.map(({ agentName, ...row }) => [agentName, piAgentState(row)]));
  const names = new Set([
    ...BUILT_IN_PI_AGENT_DEFINITIONS.map(({ agentName }) => agentName),
    ...states.keys(),
  ]);
  return [...names]
    .flatMap((agentName) => piAgentRecord(agentName, states.get(agentName) ?? null) ?? [])
    .sort(
      (left, right) =>
        (right.latestAt?.getTime() ?? -Infinity) - (left.latestAt?.getTime() ?? -Infinity) ||
        Number(right.builtIn) - Number(left.builtIn) ||
        (left.agentName < right.agentName ? -1 : left.agentName > right.agentName ? 1 : 0),
    );
}

/** The turns agents ended since `since`. */
export function readPiAgentTurns(
  reader: LofiSqliteReader,
  since: Date,
): Pick<PiAgentTurnRecord, "agentName" | "endedAt">[] {
  const turn = views.pi_agent_turn.columns;
  return reader.query({
    sql: `SELECT "agentName", "endedAt" FROM ${table("pi_agent_turn")} WHERE "endedAt" >= ?`,
    params: [since.getTime()],
    columns: { agentName: turn.agentName, endedAt: turn.endedAt },
  });
}

/** Every connection, disconnected ones too, by service and then connection ID. */
export function readIntegrationConnections(
  reader: LofiSqliteReader,
): IntegrationConnectionRecord[] {
  const connection = views.integration_connection.columns;
  const rows = reader.query({
    sql: `SELECT "id" AS "connectionId", "service", "kind", "state", "name", "authMethod",
            "eventId", "changedAt", "displayName", "kindLabel"
          FROM ${table("integration_connection")}
          ORDER BY "service", "id"`,
    params: [],
    columns: {
      connectionId: "text",
      service: connection.service,
      kind: connection.kind,
      state: connection.state,
      name: connection.name,
      authMethod: connection.authMethod,
      eventId: connection.eventId,
      changedAt: connection.changedAt,
      displayName: connection.displayName,
      kindLabel: connection.kindLabel,
    },
  });
  // Only the projection writes these rows, from `IntegrationConnectionRecord`.
  return rows as IntegrationConnectionRecord[];
}

/** The connections that are not disconnected, by service and then connection ID. */
export function readCurrentIntegrationConnections(
  reader: LofiSqliteReader,
): IntegrationConnectionRecord[] {
  return readIntegrationConnections(reader).filter(({ state }) => state !== "disconnected");
}
