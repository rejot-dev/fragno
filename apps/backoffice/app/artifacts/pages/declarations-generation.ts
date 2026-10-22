import {
  PAGE_COLLECTIONS,
  PAGE_DEFINITION_VERSION,
  PAGE_LIMITS,
  pageFields,
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
};

/**
 * Declares what page.d.ts reads from the host: every collection's synchronized row type, the
 * limits a page stays within, and the version page.define writes.
 */
export function generatePageSchemaDeclarations(): string {
  const collections = (Object.keys(PAGE_COLLECTIONS) as PageCollection[]).map((collection) => {
    const fields = pageFields(collection).map(
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
  return `// Generated from the synchronized collections and the page limits; page.d.ts declares the
// page builder that reads them.

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
