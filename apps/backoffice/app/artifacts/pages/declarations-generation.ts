import {
  PAGE_DEFINITION_VERSION,
  PAGE_LIMITS,
} from "@fragno-private/backoffice-ui/pages/definition";

import {
  AUTOMATION_PAGE_FUNCTIONS,
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
 * Declares what page.d.ts reads from the host: the relations page queries read, the functions they
 * call, the limits a page stays within, and the version page.define writes.
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
  const functions = wrap(AUTOMATION_PAGE_FUNCTIONS.join(", "), " * ");
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
 * The relations page queries read, by name, with their columns as SQL reads them. Queries read
 * nothing else; their SQL calls only these functions:
${functions}
 */
type PageRelations = {
${relations.join("\n")}
};
`;
}

/** Wraps a list at 100 columns, each line starting with `prefix`. */
function wrap(text: string, prefix: string): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && prefix.length + line.length + 1 + word.length > 100) {
      lines.push(prefix + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(prefix + line);
  return lines.join("\n");
}
