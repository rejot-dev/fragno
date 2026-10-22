import {
  PAGE_COLLECTIONS,
  PAGE_DEFINITION_VERSION,
  PAGE_LIMITS,
  type PageCollection,
  type PageFieldType,
} from "./definition";

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
    "Integration connections as their latest state change reports them, disconnected ones included; name and authMethod are null until a change carries a label.",
  agents:
    "Pi agents as their events record them now; latestKind and latestAt are null for an agent with no recorded activity. definition holds description, permissions, and managedBy.",
  agentTurns: "Turns agents ended, one row each; outcome is answered, cut-off, or failed.",
  workflowWaits:
    "Event types waiting runs wait for, one row each; runId is the run's id. interfaceStepKey names the completed step whose interface asks a person to answer, or is null.",
};

/**
 * Declares what page.d.ts reads from the host: every collection's row type, the limits a page
 * stays within, and the version page.define writes.
 */
export function generatePageSchemaDeclarations(): string {
  const collections = (Object.keys(PAGE_COLLECTIONS) as PageCollection[]).map((collection) => {
    const fields = PAGE_COLLECTIONS[collection].map(
      ({ name, type, nullable }) =>
        `    ${name}: ${FIELD_TYPES[type]}${nullable ? " | null" : ""};`,
    );
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
