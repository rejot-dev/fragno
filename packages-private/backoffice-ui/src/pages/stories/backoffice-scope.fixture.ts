import { days, hours, minutes, storyScope, withoutRows, type StoryRow } from "./story-scope";

type Run = {
  workflow: string;
  status: "complete" | "errored" | "waiting" | "active";
  createdAt: Date;
  durationMinutes: number;
  error: [name: string, message: string] | null;
};

let runCount = 0;

function run({ workflow, status, createdAt, durationMinutes, error }: Run): StoryRow {
  runCount += 1;
  const id = `run-${runCount}`;
  const updatedAt = new Date(createdAt.getTime() + durationMinutes * 60_000);
  return {
    id,
    workflowName: "codemode-script",
    remoteWorkflowName: workflow,
    instanceId: `${workflow}-${runCount}`,
    status,
    errorName: error?.[0] ?? null,
    errorMessage: error?.[1] ?? null,
    createdAt,
    updatedAt,
    completedAt: status === "complete" || status === "errored" ? updatedAt : null,
  };
}

/** Runs started at each of the given hours ago, the first failing when `failures` says so. */
function hourlyRuns(workflow: string, startedHoursAgo: number[], failures = 0): StoryRow[] {
  return startedHoursAgo.map((ago, index) =>
    run({
      workflow,
      status: index < failures ? "errored" : "complete",
      createdAt: minutes(ago * 60 + 7),
      durationMinutes: 2,
      error: index < failures ? ["RecivoFetchError", "Recivo returned 502 for the email."] : null,
    }),
  );
}

const transcriptionLoop = run({
  workflow: "inline-oga-transcription-loop",
  status: "waiting",
  createdAt: days(58),
  durationMinutes: 1,
  error: null,
});
const uploadLoop = run({
  workflow: "oga-transcription-loop",
  status: "waiting",
  createdAt: days(58),
  durationMinutes: 3,
  error: null,
});
const approval = run({
  workflow: "expense-approval",
  status: "waiting",
  createdAt: hours(5),
  durationMinutes: 1,
  error: null,
});

const runs: StoryRow[] = [
  ...hourlyRuns("recivo-email-received", [0, 1, 1, 2, 4, 5, 7, 9, 12, 15, 18, 22], 2),
  ...hourlyRuns("telegram-user-linking", [0, 3, 6, 11, 20]),
  ...hourlyRuns("project-files-configure", [2, 14]),
  run({
    workflow: "telegram-user-pi-linking",
    status: "errored",
    createdAt: hours(3),
    durationMinutes: 1,
    error: ["IdentityClaimExpired", "The identity claim expired before the user answered."],
  }),
  run({
    workflow: "marketplace-ingest",
    status: "active",
    createdAt: minutes(4),
    durationMinutes: 0,
    error: null,
  }),
  run({
    workflow: "ui-greeting",
    status: "complete",
    createdAt: days(1),
    durationMinutes: 1,
    error: null,
  }),
  run({
    workflow: "generate-moonlit-harbor-image",
    status: "complete",
    createdAt: days(2),
    durationMinutes: 4,
    error: null,
  }),
  run({
    workflow: "button-error-in-step-demo",
    status: "errored",
    createdAt: days(5),
    durationMinutes: 1,
    error: ["Error", "Button handler threw."],
  }),
  transcriptionLoop,
  uploadLoop,
  approval,
];

const steps: StoryRow[] = [
  {
    id: "step-1",
    runId: transcriptionLoop.id,
    stepKey: "show-form",
    name: "show OGA upload form 0",
  },
  {
    id: "step-2",
    runId: uploadLoop.id,
    stepKey: "request-upload",
    name: "request OGA upload 0",
  },
  { id: "step-3", runId: approval.id, stepKey: "notify", name: "notify approver" },
];

const waits: StoryRow[] = [
  {
    id: `${String(transcriptionLoop.id)}:oga-upload`,
    runId: transcriptionLoop.id,
    eventType: "oga-upload",
    interfaceStepKey: "show-form",
  },
  {
    id: `${String(uploadLoop.id)}:oga-upload`,
    runId: uploadLoop.id,
    eventType: "oga-upload",
    interfaceStepKey: "request-upload",
  },
  {
    id: `${String(approval.id)}:approval.decided`,
    runId: approval.id,
    eventType: "approval.decided",
    interfaceStepKey: null,
  },
];

/** Events from each source, counted per hour ago. */
function events(source: string, perHourAgo: number[]): StoryRow[] {
  return perHourAgo.flatMap((count, ago) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${source}-${ago}-${index}`,
      source,
      occurredAt: minutes(ago * 60 + index * 3 + 1),
    })),
  );
}

const eventRows: StoryRow[] = [
  ...events("telegram", [3, 2, 0, 1, 4, 2, 1, 0, 0, 0, 1, 2, 3, 1, 0, 0, 0, 0, 2, 1, 0, 1, 2, 1]),
  ...events("recivo", [2, 2, 1, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0]),
  ...events("codemode", [2, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
];

/** Connections whose events carried no label have no name, as older connections do. */
const connection = (
  connectionId: string,
  service: string,
  [kind, kindLabel]: [string, string],
  [name, displayName]: [string | null, string],
  state: string,
  changedAt: Date,
): StoryRow => ({
  connectionId,
  service,
  kind,
  state,
  name,
  authMethod: kind === "mcp" ? "oauth" : null,
  eventId: `connection-${connectionId}`,
  changedAt,
  displayName,
  kindLabel,
});

const agentTurns: StoryRow[] = [1, 1, 2, 3, 3, 5, 8, 9, 13, 20, 26].map((ago, index) => ({
  id: `turn-${index}`,
  agentName: ago < 10 ? "triage" : "assistant",
  outcome: index === 4 ? "failed" : "answered",
  endedAt: hours(ago),
}));

/** A scope where automations ran over the last day and some work waits on a person. */
export const BUSY_SCOPE = storyScope({
  runs,
  steps,
  workflow_waits: waits,
  events: eventRows,
  connections: [
    connection("mcp#agensi", "agensi", ["mcp", "MCP"], [null, "agensi"], "ready", days(8)),
    connection(
      "backoffice#telegram",
      "telegram",
      ["native", "Native · telegram"],
      [null, "telegram"],
      "ready",
      days(10),
    ),
    connection(
      "webhook#recivo",
      "recivo",
      ["webhook", "Webhook"],
      [null, "recivo"],
      "ready",
      days(8),
    ),
    connection(
      "mcp#github",
      "github",
      ["mcp", "MCP"],
      ["GitHub", "GitHub"],
      "unavailable",
      hours(2),
    ),
  ],
  routes: [
    {
      id: "route-digest",
      name: "Morning digest",
      enabled: true,
      trigger: { kind: "schedule", cron: "0 7 * * *" },
    },
    {
      id: "route-telegram",
      name: "Telegram /start identity linking",
      enabled: true,
      trigger: { kind: "event", eventType: "telegram.message.received" },
    },
  ],
  route_schedules: [{ id: "route-digest", nextOccurrenceAt: hours(-17) }],
  agents: [
    {
      agentName: "assistant",
      definition: { description: "Answers questions about this organization." },
      builtIn: true,
      latestKind: "answered",
      latestAt: days(1),
      answering: false,
      queued: 0,
      steering: 0,
      paused: false,
      displayName: "Assistant",
      activity: "Answered",
    },
    {
      agentName: "triage",
      definition: { description: "Sorts incoming email into projects." },
      builtIn: false,
      latestKind: "started",
      latestAt: minutes(2),
      answering: true,
      queued: 2,
      steering: 0,
      paused: false,
      displayName: "Triage",
      activity: "Answering",
    },
  ],
  agent_turns: agentTurns,
});

/** The same relations with no rows, as a new scope has them. */
export const EMPTY_SCOPE = withoutRows(BUSY_SCOPE);
