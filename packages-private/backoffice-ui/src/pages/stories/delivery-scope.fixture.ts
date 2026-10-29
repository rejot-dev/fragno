import { minutes, storyScope, withoutRows, type StoryRow } from "./story-scope";

/**
 * An hourly workflow checking an order's expected delivery, shaped as the delivery pages read it:
 * each run's compare-and-save-json step saves the estimate it read and, when the estimate moved,
 * the change. The production Vodafone page and the delivery-tracker example read the same data
 * under different names, so scopes take the names their page reads.
 */

/** A check read an estimate, or failed with an error. */
type Check = string | { error: string };

/** The step's result: the estimate the check read, and the change when it differs from the last. */
function checkResult(estimate: string, previous: string | null): StoryRow {
  return previous === null || previous === estimate
    ? { expectedDelivery: estimate, changed: false, pending: null }
    : { expectedDelivery: estimate, changed: true, pending: { from: previous, to: estimate } };
}

/** One run of `workflow` per hour ago, newest first, each started five minutes past the hour. */
function hourlyChecks(workflow: string, checks: Check[]): { runs: StoryRow[]; steps: StoryRow[] } {
  const runs: StoryRow[] = [];
  const steps: StoryRow[] = [];
  let previous: string | null = null;
  // Oldest first, so each check compares against the estimate before it.
  for (let hoursAgo = checks.length - 1; hoursAgo >= 0; hoursAgo -= 1) {
    const check = checks[hoursAgo];
    const createdAt = minutes(hoursAgo * 60 + 55);
    const updatedAt = new Date(createdAt.getTime() + 40_000);
    const id = `run-delivery-${hoursAgo}`;
    runs.push({
      id,
      workflowName: "codemode-script",
      remoteWorkflowName: workflow,
      instanceId: `${workflow}-${(createdAt.getTime() / 1000).toString(36)}`,
      status: typeof check === "string" ? "complete" : "errored",
      errorMessage: typeof check === "string" ? null : check.error,
      createdAt,
      updatedAt,
    });
    steps.push({
      id: `step-delivery-${hoursAgo}`,
      runId: id,
      name: "compare-and-save-json",
      status: typeof check === "string" ? "completed" : "errored",
      result: typeof check === "string" ? checkResult(check, previous) : null,
      updatedAt,
    });
    if (typeof check === "string") {
      previous = check;
    }
  }
  return { runs, steps };
}

const PAGE_TIMEOUT = { error: "The shop's order page did not load within 30 seconds." };
const NO_ESTIMATE = { error: "The order page showed no expected delivery to extract." };

const repeat = (count: number, check: Check): Check[] => Array.from({ length: count }, () => check);

/** Two days of checks: the estimate moved twice and a few checks failed. */
const TRACKED: Check[] = [
  ...repeat(3, "Oct 26 – Oct 27"),
  PAGE_TIMEOUT,
  ...repeat(3, "Oct 26 – Oct 27"),
  ...repeat(10, "Oct 26 – Oct 28"),
  NO_ESTIMATE,
  PAGE_TIMEOUT,
  ...repeat(12, "Oct 26 – Oct 28"),
  ...repeat(6, "Oct 27 – Oct 30"),
];

/** Checks failing for the last five hours, until someone paused the schedule. */
const FAILING: Check[] = [
  ...repeat(4, PAGE_TIMEOUT),
  NO_ESTIMATE,
  ...repeat(2, "Oct 26 – Oct 27"),
  "Oct 26 – Oct 28",
];

/** The names a delivery page reads: its workflow and the route that schedules it. */
type MonitorNames = { workflow: string; routeId: string };

/** A monitor's scopes: tracking for two days, failing and paused, and running its first check. */
export function deliveryScopes({ workflow, routeId }: MonitorNames) {
  const hourlyRoute = (enabled: boolean): StoryRow => ({
    id: routeId,
    name: "Order delivery · hourly",
    enabled,
    trigger: { kind: "schedule", cron: "5 * * * *" },
  });
  const nextCheck = { id: routeId, nextOccurrenceAt: minutes(-5) };
  const tracked = hourlyChecks(workflow, TRACKED);
  const failing = hourlyChecks(workflow, FAILING);

  const tracking = storyScope({
    runs: tracked.runs,
    steps: tracked.steps,
    routes: [hourlyRoute(true)],
    route_schedules: [nextCheck],
  });
  return {
    tracking,
    failing: storyScope({
      runs: failing.runs,
      steps: failing.steps,
      routes: [hourlyRoute(false)],
      route_schedules: [{ id: routeId, nextOccurrenceAt: null }],
    }),
    firstCheck: {
      ...withoutRows(tracking),
      ...storyScope({
        runs: [
          {
            id: "run-delivery-first",
            workflowName: "codemode-script",
            remoteWorkflowName: workflow,
            instanceId: `${workflow}-first`,
            status: "active",
            errorMessage: null,
            createdAt: minutes(1),
            updatedAt: minutes(1),
          },
        ],
        routes: [hourlyRoute(true)],
        route_schedules: [nextCheck],
      }),
    },
  };
}
