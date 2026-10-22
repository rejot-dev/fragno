import {
  PAGE_DEFINITION_VERSION,
  PAGE_LIMITS,
  type PageFieldType,
} from "@fragno-private/backoffice-ui/pages/definition";
import { RUN_STATUSES } from "@fragno-private/backoffice-ui/run-status";

import { PAGE_COLLECTIONS, type PageCollection } from "./collections";

const FIELD_TYPES: Record<PageFieldType, string> = {
  string: "string",
  number: "number",
  bigint: "bigint",
  boolean: "boolean",
  time: "Date",
  json: "unknown",
  binary: "Uint8Array",
};

const COLLECTION_NOTES: Partial<Record<PageCollection, string>> = {
  workflowInstances:
    "Workflow runs. workflowName is the runner's internal name; remoteWorkflowName is the workflow's own name.",
  workflowSteps: "Steps of workflow runs; instanceRef is the run's id.",
  events: "Automation events, newest by occurredAt.",
  routes:
    "Automation routes; routeScheduleStates holds a scheduled route's next occurrence by the same id.",
  kvStore: "Values stored with the store provider.",
  connections:
    "Integration connections as their latest state change reports them, disconnected ones included; name and authMethod are null until a change carries a label. displayName is what people call the connection and kindLabel its kind, such as MCP.",
  agents:
    "Pi agents as their events record them now; latestKind and latestAt are null for an agent with no recorded activity. displayName is the name people read and activity what the agent does or did last, such as Answered. definition holds description, permissions, and managedBy.",
  agentTurns: "Turns agents ended, one row each; outcome is answered, cut-off, or failed.",
  workflowWaits:
    "Event types waiting runs wait for, one row each; runId is the run's id. interfaceStepKey names the completed step whose interface asks a person to answer, or is null.",
};

/**
 * Fields whose writer stores only these values, declared as their union so a page can pass them to
 * components that take one of them, such as ui.runStatus.
 */
const FIELD_VALUES: Partial<Record<PageCollection, Record<string, readonly string[]>>> = {
  workflowInstances: { status: RUN_STATUSES },
};

/**
 * Declares what page.d.ts reads from the host: every collection's row type, the limits a page
 * stays within, and the version page.define writes.
 */
export function generatePageSchemaDeclarations(): string {
  const collections = (Object.keys(PAGE_COLLECTIONS) as PageCollection[]).map((collection) => {
    const fields = PAGE_COLLECTIONS[collection].map(({ name, type, nullable }) => {
      const values = FIELD_VALUES[collection]?.[name];
      const declared = values ? values.map((value) => JSON.stringify(value)).join(" | ") : null;
      return `    ${name}: ${declared ?? FIELD_TYPES[type]}${nullable ? " | null" : ""};`;
    });
    const note = COLLECTION_NOTES[collection];
    return [
      ...(note ? [`  /** ${note} */`] : []),
      `  ${collection}: PageCollection<{`,
      ...fields,
      "  }>;",
    ].join("\n");
  });
  const limits = Object.entries(PAGE_LIMITS).map(([name, limit]) => `  ${name}: ${limit};`);
  return `// Generated from the page collections and the page limits; page.d.ts declares the page
// builder that reads them.

/** The most a page asks for; a build beyond them fails. */
type PageLimits = {
${limits.join("\n")}
};

/** The version of the definition page.define writes. */
type PageDefinitionVersion = ${PAGE_DEFINITION_VERSION};

type PageCollections = {
${collections.join("\n")}
};
`;
}
