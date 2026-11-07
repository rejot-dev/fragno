import type { SqliteValue } from "@fragno-dev/lofi/sqlite";
import { PAGE_LIMITS } from "@fragno-private/backoffice-ui/pages/definition";

/**
 * What one read of a site's Worker may ask for and return. A query has the bounds of a page's;
 * results are bounded too, since a site sends them on rather than showing them.
 */
export const SITE_DATA_LIMITS = {
  sqlLength: PAGE_LIMITS.sqlLength,
  params: PAGE_LIMITS.params,
  listItems: PAGE_LIMITS.listItems,
  rows: 10_000,
  /** Bytes of the rows' text, in UTF-8, and blobs, and eight for each other value. */
  bytes: 4 * 1024 * 1024,
} as const;

/** A read a site's Worker asks for: one SELECT over the page relations, and its parameters. */
export type SiteDataQuery = { sql: string; params: SqliteValue[] };

/**
 * The read's rows, as arrays of values in its columns' order, why it cannot run, or that the
 * scope's copy has not yet caught up with Automations, which leaves the site unavailable.
 */
export type SiteDataResult =
  | { status: "ready"; columns: string[]; rows: SqliteValue[][] }
  | { status: "error"; message: string }
  | { status: "catching-up" };

/** The site Worker's binding that `env.DATA` reads through. */
export type SiteDataBinding = { query(query: SiteDataQuery): Promise<SiteDataResult> };

/**
 * Why a query cannot be a site's read, or null: as a page's, it is one SELECT, which may start
 * with WITH, binding only text, numbers, and null. Reads run in a transaction that rolls back, so
 * this is what lets them fail clearly; it is not what keeps the data intact.
 */
export function siteDataQueryProblem(query: SiteDataQuery): string | null {
  if (query.sql.length > SITE_DATA_LIMITS.sqlLength) {
    return `A query is at most ${SITE_DATA_LIMITS.sqlLength} characters of SQL.`;
  }
  if (query.params.length > SITE_DATA_LIMITS.params) {
    return `A query binds at most ${SITE_DATA_LIMITS.params} values; a list binds one.`;
  }
  if (
    query.params.some((param) => param !== null && !["string", "number"].includes(typeof param))
  ) {
    return "A query binds text, numbers, and null.";
  }
  const statement = sqlStatement(query.sql);
  if (statement.more) {
    return "A query is one statement; remove what follows its semicolon.";
  }
  switch (statement.keyword) {
    case "SELECT":
    case "WITH":
      return null;
    case "INSERT":
    case "UPDATE":
    case "DELETE":
    case "REPLACE":
    case "CREATE":
    case "DROP":
    case "ALTER":
    case "REINDEX":
    case "VACUUM":
      return "Queries only read: they cannot write.";
    case "BEGIN":
    case "COMMIT":
    case "END":
    case "ROLLBACK":
    case "SAVEPOINT":
    case "RELEASE":
      return "Queries cannot begin or end transactions.";
    case "ATTACH":
    case "DETACH":
      return "Queries cannot attach or detach databases.";
    default:
      return "A query is one SELECT, and may start with WITH.";
  }
}

/**
 * A SQLite error as a site reads it, worded as a page's: without the result code Durable Object
 * SQLite appends, and naming the relations when the query read none of them.
 */
export function describeSiteDataError(error: unknown, relations: readonly string[]): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/^SQLite error \d+: /u, "")
    .replace(/: SQLITE_[A-Z_]+$/u, "");
  return message.startsWith("no such table:")
    ? `${message}. Read one of: ${relations.join(", ")}.`
    : message;
}

/**
 * The first keyword of `sql`, uppercased, and whether another statement follows its first
 * semicolon. Text in quotes, brackets, and comments is skipped, as SQLite reads it.
 */
function sqlStatement(sql: string): { keyword: string; more: boolean } {
  let keyword = "";
  let ended = false;
  let index = 0;
  const skipUntil = (end: string, from: number) => {
    const found = sql.indexOf(end, from);
    return found === -1 ? sql.length : found + end.length;
  };
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      index = skipUntil("\n", index + 2);
      continue;
    }
    if (char === "/" && next === "*") {
      index = skipUntil("*/", index + 2);
      continue;
    }
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (ended) {
      return { keyword, more: true };
    }
    if (char === ";") {
      ended = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      // A doubled quote is one quote inside the quoted text, which skipping twice reads past.
      index = skipUntil(char, index + 1);
    } else if (char === "[") {
      index = skipUntil("]", index + 1);
    } else {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(sql.slice(index))?.[0];
      if (word && keyword === "") {
        keyword = word.toUpperCase();
      }
      index += word?.length ?? 1;
    }
  }
  return { keyword, more: false };
}
