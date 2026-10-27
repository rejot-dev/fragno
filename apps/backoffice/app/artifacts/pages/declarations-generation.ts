import {
  PAGE_DEFINITION_VERSION,
  PAGE_LIMITS,
} from "@fragno-private/backoffice-ui/pages/definition";

import {
  AUTOMATION_PAGE_RELATIONS,
  type PageRelationColumnType,
} from "@/fragno/automation/lofi/page-relations";

const COLUMN_TYPES: Record<PageRelationColumnType, string> = {
  text: "string",
  integer: "number",
  number: "number",
  boolean: "PageSqlBoolean",
  time: "PageSqlTime",
  json: "PageSqlJson",
  blob: "Uint8Array",
};

/**
 * Declares what page.d.ts reads from the host: the relations page queries read, the limits a page
 * stays within, and the version page.define writes.
 */
export function generatePageSchemaDeclarations(): string {
  const relations = AUTOMATION_PAGE_RELATIONS.map(({ name, description, columns }) => {
    const fields = columns.map(({ name: column, type, nullable, values }) => {
      const declared = values ? values.map((value) => JSON.stringify(value)).join(" | ") : null;
      return `    ${column}: ${declared ?? COLUMN_TYPES[type]}${nullable ? " | null" : ""};`;
    });
    return [`  /** ${description} */`, `  ${name}: {`, ...fields, "  };"].join("\n");
  });
  const limits = Object.entries(PAGE_LIMITS).map(([name, limit]) => `  ${name}: ${limit};`);
  return `// Generated from the page relations and the page limits; page.d.ts declares the page
// builder whose queries read them.

/** The most a page asks for; a build beyond them fails. */
type PageLimits = {
${limits.join("\n")}
};

/** The version of the definition page.define writes. */
type PageDefinitionVersion = ${PAGE_DEFINITION_VERSION};

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
${relations.join("\n")}
};
`;
}
