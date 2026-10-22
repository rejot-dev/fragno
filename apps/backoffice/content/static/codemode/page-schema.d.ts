// Generated from the page collections and the page limits; page.d.ts declares the page
// builder that reads them.

/** The most a page asks for; a build beyond them fails. */
type PageLimits = {
  queries: 16;
  values: 32;
  queryParts: 16;
  unionBranches: 8;
  rowsPerQuery: 100;
  buckets: 60;
  minimumBucketMs: 60000;
  expressionDepth: 32;
  listItems: 100;
};

/** The version of the definition page.define writes. */
type PageDefinitionVersion = 3;

type PageCollections = {
  projects: PageCollection<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    archivedAt: Date | null;
    createdByUserId: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
  /** Automation routes; routeScheduleStates holds a scheduled route's next occurrence by the same id. */
  routes: PageCollection<{
    id: string;
    name: string;
    enabled: boolean;
    priority: number;
    trigger: unknown;
    action: unknown;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    metadata: unknown | null;
  }>;
  routeScheduleStates: PageCollection<{
    id: string;
    initializationAt: Date | null;
    nextOccurrenceAt: Date | null;
  }>;
  routeDispatches: PageCollection<{
    id: string;
    eventId: string;
    rootEventId: string;
    routeId: string;
    routeName: string;
    outcome: unknown | null;
    dispatchedAt: Date;
    status: string;
    failedAttempts: number;
    error: string | null;
  }>;
  /** Automation events, newest by occurredAt. */
  events: PageCollection<{
    id: string;
    scope: unknown;
    source: string;
    eventType: string;
    occurredAt: Date;
    payload: unknown;
    actors: unknown;
    subject: unknown | null;
    createdAt: Date;
    scopeRestriction: unknown | null;
    causation: unknown | null;
    rootEventId: string | null;
    routesMatched: boolean;
  }>;
  eventSources: PageCollection<{
    id: string;
    source: string;
    label: string;
    description: string;
    category: unknown;
    createdAt: Date;
    updatedAt: Date;
  }>;
  eventDefinitions: PageCollection<{
    id: string;
    source: string;
    eventType: string;
    label: string;
    description: string | null;
    payloadSchema: unknown | null;
    actorSchema: unknown | null;
    subjectSchema: unknown | null;
    example: unknown | null;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }>;
  /** Values stored with the store provider. */
  kvStore: PageCollection<{
    id: string;
    key: string;
    value: string;
    description: string | null;
    category: unknown | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  /** Workflow runs. workflowName is the runner's internal name; remoteWorkflowName is the workflow's own name. */
  workflowInstances: PageCollection<{
    id: string;
    workflowName: string;
    remoteWorkflowName: string | null;
    instanceId: string;
    status: string;
    runGeneration: number;
    createdAt: Date;
    updatedAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    params: unknown;
    output: unknown | null;
    errorName: string | null;
    errorMessage: string | null;
    interruptedTicks: number;
  }>;
  /** Steps of workflow runs; instanceRef is the run's id. */
  workflowSteps: PageCollection<{
    id: string;
    instanceRef: string;
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
    nextRetryAt: Date | null;
    wakeAt: Date | null;
    waitEventType: string | null;
    result: unknown | null;
    errorName: string | null;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  workflowEvents: PageCollection<{
    id: string;
    instanceRef: string;
    actor: string;
    type: string;
    payload: unknown | null;
    createdAt: Date;
    deliveredAt: Date | null;
    consumedByStepKey: string | null;
  }>;
  /** Integration connections as their latest state change reports them, disconnected ones included; name and authMethod are null until a change carries a label. */
  connections: PageCollection<{
    connectionId: string;
    service: string;
    kind: string;
    state: string;
    name: string | null;
    authMethod: string | null;
    eventId: string;
    changedAt: Date;
  }>;
  /** Pi agents as their events record them now; latestKind and latestAt are null for an agent with no recorded activity. definition holds description, permissions, and managedBy. */
  agents: PageCollection<{
    agentName: string;
    definition: unknown;
    builtIn: boolean;
    latestKind: string | null;
    latestAt: Date | null;
    answering: boolean;
    queued: number;
    steering: number;
    paused: boolean;
  }>;
  /** Turns agents ended, one row each; outcome is answered, cut-off, or failed. */
  agentTurns: PageCollection<{
    id: string;
    agentName: string;
    outcome: string;
    endedAt: Date;
  }>;
  /** Event types waiting runs wait for, one row each; runId is the run's id. interfaceStepKey names the completed step whose interface asks a person to answer, or is null. */
  workflowWaits: PageCollection<{
    id: string;
    runId: string;
    eventType: string;
    interfaceStepKey: string | null;
  }>;
};
