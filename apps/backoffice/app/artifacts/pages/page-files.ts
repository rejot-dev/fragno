import type {
  PageFile,
  PageFileColumn,
  PageFileColumns,
} from "@fragno-private/backoffice-ui/pages/definition";
import { pageFileRecord, type PageData } from "@fragno-private/backoffice-ui/pages/rows";

import { parseFrontmatter } from "@/lib/frontmatter";

/** A file's text does not hold what its format or the page's declaration reads. */
export class PageFileError extends Error {}

/**
 * A file's text as the page binds it: JSON as it parses; CSV as one row per record after its
 * header, of the declared columns; Markdown as `{ body, frontmatter }`, of the declared fields.
 * Throws PageFileError, or PageRowsError for a value that does not fit its column.
 */
export function pageFileData(file: PageFile, text: string): PageData {
  switch (file.format) {
    case "json":
      try {
        return JSON.parse(text) as PageData;
      } catch (error) {
        throw new PageFileError(
          `The file is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    case "csv":
      return csvRows(file.columns, text);
    case "markdown":
      return markdownDocument(file.frontmatter, text);
    default:
      throw new Error("Unsupported page file format.", { cause: file satisfies never });
  }
}

function csvRows(columns: PageFileColumns, text: string): PageData[] {
  const [header, ...records] = parseCsv(text);
  if (!header) {
    throw new PageFileError("The CSV has no header row naming its columns.");
  }
  const names = header.map((name) => name.trim());
  const present = new Set(names);
  const missing = Object.keys(columns).filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new PageFileError(
      `The CSV's header has no ${missing.map((name) => JSON.stringify(name)).join(", ")} column. It has: ${names.join(", ")}.`,
    );
  }
  return records.map((cells, index) => {
    const path = `Row ${index + 1}`;
    return pageFileRecord(
      columns,
      Object.fromEntries(
        Object.entries(columns).map(([name, column]) => [
          name,
          csvValue(column, cells[names.indexOf(name)] ?? "", `${path}, field "${name}"`),
        ]),
      ),
      path,
    );
  });
}

/**
 * Records of RFC 4180 CSV: a quoted field may hold commas, line breaks, and doubled quotes.
 * Spreadsheets start their exports with a byte order mark, and blank lines hold no record.
 */
function parseCsv(text: string): string[][] {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;
  const endRecord = () => {
    record.push(field);
    if (record.length > 1 || record[0] !== "") {
      records.push(record);
    }
    record = [];
    field = "";
  };
  while (index < source.length) {
    const char = source[index];
    index += 1;
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (source[index] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index] === "\n") {
        index += 1;
      }
      endRecord();
    } else {
      field += char;
    }
  }
  if (quoted) {
    throw new PageFileError("The CSV ends inside a quoted field.");
  }
  if (field !== "" || record.length > 0) {
    endRecord();
  }
  return records;
}

/** A cell's text as the value its column reads; an empty cell is null where null fits. */
function csvValue(column: PageFileColumn, cell: string, path: string): unknown {
  if (cell === "" && acceptsNull(column)) {
    return null;
  }
  if (typeof column !== "string") {
    return cell;
  }
  switch (column.replace(/\?$/u, "")) {
    case "number": {
      const number = Number(cell);
      return cell.trim() !== "" && Number.isFinite(number) ? number : cell;
    }
    case "boolean":
      return cell === "true" ? true : cell === "false" ? false : cell;
    case "time":
      return textTime(cell);
    case "json":
      try {
        return JSON.parse(cell) as unknown;
      } catch {
        throw new PageFileError(`${path} is declared "json" but holds text that is not JSON.`);
      }
    default:
      return cell;
  }
}

function markdownDocument(columns: PageFileColumns, text: string): PageData {
  const parsed = parseFrontmatter<Record<string, unknown>>(text);
  if (!parsed.ok) {
    throw new PageFileError(`The frontmatter is not YAML: ${parsed.error.message}`);
  }
  const { frontmatter, body } = parsed.value;
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new PageFileError("The frontmatter is not a mapping of fields, such as `owner: Ada`.");
  }
  // Frontmatter fields are optional by nature, so one a file leaves out, or sets to null, reads as
  // null whatever its declaration; pages show what reads it with ui.when.
  const present = Object.fromEntries(
    Object.entries(columns).filter(
      ([name]) => frontmatter[name] !== undefined && frontmatter[name] !== null,
    ),
  );
  const decoded = pageFileRecord(
    present,
    Object.fromEntries(
      Object.entries(present).map(([name, column]) => [
        name,
        frontmatterValue(column, frontmatter[name]),
      ]),
    ),
    "The frontmatter",
  );
  return {
    body,
    frontmatter: Object.fromEntries(
      Object.keys(columns).map((name) => [
        name,
        Object.hasOwn(decoded, name) ? decoded[name]! : null,
      ]),
    ),
  };
}

/** YAML reads dates as text, which a time column reads as milliseconds since the epoch. */
function frontmatterValue(column: PageFileColumn, value: unknown): unknown {
  if (typeof column === "string" && column.startsWith("time")) {
    return value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? textTime(value)
        : value;
  }
  return value;
}

/** An ISO 8601 date or time as milliseconds since the epoch; other text stays text. */
function textTime(text: string): unknown {
  const time = /^\d{4}-\d{2}-\d{2}/u.test(text) ? Date.parse(text) : Number.NaN;
  return Number.isFinite(time) ? time : text;
}

function acceptsNull(column: PageFileColumn): boolean {
  return typeof column === "string" ? column.endsWith("?") : column.includes(null);
}
