// Generated from the page relations and the page limits; page.d.ts declares the page
// builder whose queries read them.

/** The most a page asks for; a build beyond them fails. */
type PageLimits = {
  titleLength: 80;
  queries: 16;
  values: 32;
  sqlLength: 20000;
  params: 100;
  columns: 64;
  nestedRows: 3;
  rowsPerQuery: 500;
  buckets: 60;
  minimumBucketMs: 60000;
  listItems: 100;
};

/** The version of the definition page.define writes. */
type PageDefinitionVersion = 5;

/** A time as SQL reads it: milliseconds since the epoch. Declare its column "time" to show it. */
type PageSqlTime = number;
/** A boolean as SQL reads it: 0 or 1. Declare its column "boolean" to show it as true or false. */
type PageSqlBoolean = 0 | 1;
/**
 * JSON text. Read a field with ->> such as payload ->> '$.action', which returns SQL values, or
 * nest it in other JSON with json(...) or ->.
 */
type PageSqlJson = string;

/**
 * The relations page queries read, by name, with their columns as SQL reads them. A synchronized
 * table's position grows in the order its rows were created: rows created together, such as a run's
 * steps, share their createdAt, so order them by createdAt, position. Queries call SQLite's
 * functions, except random(), randomblob(), and those reporting on the connection. Read the time
 * from the builder's now, not date('now'): a query runs again only when what it reads changes.
 */
type PageRelations = {
  /** Workflow runs. workflowName is the runner's internal name, and remoteWorkflowName the workflow's own name, or null. */
  runs: {
    id: string;
    workflowName: string;
    remoteWorkflowName: string | null;
    instanceId: string;
    status: "active" | "paused" | "waiting" | "complete" | "errored" | "terminated";
    runGeneration: number;
    createdAt: PageSqlTime;
    updatedAt: PageSqlTime;
    startedAt: PageSqlTime | null;
    completedAt: PageSqlTime | null;
    params: PageSqlJson;
    output: PageSqlJson | null;
    errorName: string | null;
    errorMessage: string | null;
    interruptedTicks: number;
    position: number;
  };
  /** Steps of workflow runs; runId is the run's id. */
  steps: {
    id: string;
    runId: string;
    stepKey: string;
    parentStepKey: string | null;
    depth: number;
    name: string;
    type: string;
    status: string;
    committedByExecutionId: string;
    attempts: number;
    maxAttempts: number;
    timeoutMs: number | null;
    nextRetryAt: PageSqlTime | null;
    wakeAt: PageSqlTime | null;
    waitEventType: string | null;
    result: PageSqlJson | null;
    errorName: string | null;
    errorMessage: string | null;
    createdAt: PageSqlTime;
    updatedAt: PageSqlTime;
    position: number;
  };
  /** Events delivered to workflow runs; runId is the run's id. */
  workflow_events: {
    id: string;
    runId: string;
    actor: string;
    type: string;
    payload: PageSqlJson | null;
    createdAt: PageSqlTime;
    deliveredAt: PageSqlTime | null;
    consumedByStepKey: string | null;
    position: number;
  };
  /** Automation events. payload, actors, and subject are JSON; read fields with ->> such as payload ->> '$.action'. */
  events: {
    id: string;
    scope: PageSqlJson;
    source: string;
    eventType: string;
    occurredAt: PageSqlTime;
    payload: PageSqlJson;
    actors: PageSqlJson;
    subject: PageSqlJson | null;
    createdAt: PageSqlTime;
    scopeRestriction: PageSqlJson | null;
    causation: PageSqlJson | null;
    rootEventId: string | null;
    routesMatched: PageSqlBoolean;
    position: number;
  };
  /** The sources events come from. */
  event_sources: {
    id: string;
    source: string;
    label: string;
    description: string;
    category: PageSqlJson;
    createdAt: PageSqlTime;
    updatedAt: PageSqlTime;
    position: number;
  };
  /** The event types sources define. */
  event_definitions: {
    id: string;
    source: string;
    eventType: string;
    label: string;
    description: string | null;
    payloadSchema: PageSqlJson | null;
    actorSchema: PageSqlJson | null;
    subjectSchema: PageSqlJson | null;
    example: PageSqlJson | null;
    enabled: PageSqlBoolean;
    createdAt: PageSqlTime;
    updatedAt: PageSqlTime;
    steward: PageSqlJson | null;
    position: number;
  };
  /** Automation routes. trigger and action are JSON, such as trigger ->> '$.kind'; route_schedules holds a scheduled route's next occurrence by the same id. */
  routes: {
    id: string;
    name: string;
    enabled: PageSqlBoolean;
    priority: number;
    trigger: PageSqlJson;
    action: PageSqlJson;
    description: string | null;
    createdAt: PageSqlTime;
    updatedAt: PageSqlTime;
    metadata: PageSqlJson | null;
    position: number;
  };
  /** When each scheduled route next fires, by the route's id. */
  route_schedules: {
    id: string;
    initializationAt: PageSqlTime | null;
    nextOccurrenceAt: PageSqlTime | null;
    position: number;
  };
  /** Each time a route led an event to its action. */
  route_dispatches: {
    id: string;
    eventId: string;
    rootEventId: string;
    routeId: string;
    routeName: string;
    outcome: PageSqlJson | null;
    dispatchedAt: PageSqlTime;
    status: string;
    failedAttempts: number;
    error: string | null;
    position: number;
  };
  /** The scope's projects. */
  projects: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    archivedAt: PageSqlTime | null;
    createdByUserId: string;
    createdAt: PageSqlTime;
    updatedAt: PageSqlTime;
    position: number;
  };
  /** Values stored with the store provider. */
  kv_store: {
    id: string;
    key: string;
    value: string;
    description: string | null;
    category: PageSqlJson | null;
    createdAt: PageSqlTime;
    updatedAt: PageSqlTime;
    position: number;
  };
  /** Integration connections as their latest state change reports them, disconnected ones included; name and authMethod are null until a change carries a label. displayName is what people call the connection and kindLabel its kind, such as MCP. */
  connections: {
    connectionId: string;
    service: string;
    kind: string;
    state: "ready" | "unavailable" | "disconnected";
    name: string | null;
    authMethod: string | null;
    eventId: string;
    changedAt: PageSqlTime;
    displayName: string;
    kindLabel: string;
  };
  /** Turns agents ended, one row each. */
  agent_turns: {
    id: string;
    agentName: string;
    outcome: "answered" | "cut-off" | "failed";
    endedAt: PageSqlTime;
  };
  /** Pi agents, built-in ones included, as their events record them now; latestKind and latestAt are null for an agent with no recorded activity. displayName is the name people read and activity what the agent does or did last, such as Answered. definition is JSON holding description, permissions, and steward. */
  agents: {
    agentName: string;
    definition: PageSqlJson;
    builtIn: PageSqlBoolean;
    latestKind: string | null;
    latestAt: PageSqlTime | null;
    answering: PageSqlBoolean;
    queued: number;
    steering: number;
    paused: PageSqlBoolean;
    displayName: string;
    activity: string;
  };
  /** Event types waiting runs wait for, one row each; runId is the run's id. interfaceStepKey names the completed step whose interface asks a person to answer, or is null. */
  workflow_waits: {
    id: string;
    runId: string;
    eventType: string;
    interfaceStepKey: string | null;
  };
};
