import SQLiteESMFactory from "@journeyapps/wa-sqlite/dist/wa-sqlite.mjs";

import * as SQLite from "@journeyapps/wa-sqlite";

import type { PageDefinition } from "../definition";
import { pageQueryParams } from "../rows";
import type { PageQueryState } from "../view";

/**
 * The time stories run pages at. Fixtures write their times relative to it, so relative times and
 * hourly charts read the same in every run of a story.
 */
export const STORY_NOW = Date.UTC(2026, 9, 22, 14, 0);

export const minutes = (count: number) => new Date(STORY_NOW - count * 60_000);
export const hours = (count: number) => minutes(count * 60);
export const days = (count: number) => hours(count * 24);

export type StoryRow = Record<string, unknown>;

type StoryRelation = { columns: string[]; rows: StoryRow[] };

/** The relations a story's page reads, as Backoffice synchronizes and derives them. */
export type StoryScope = Record<string, StoryRelation>;

/** Relations of the given rows, each with the columns its rows have. */
export function storyScope(rowsByRelation: Record<string, StoryRow[]>): StoryScope {
  return Object.fromEntries(
    Object.entries(rowsByRelation).map(([name, rows]) => [
      name,
      { columns: [...new Set(rows.flatMap((row) => Object.keys(row)))], rows },
    ]),
  );
}

/** The same relations with no rows, as a new scope has them. */
export function withoutRows(scope: StoryScope): StoryScope {
  return Object.fromEntries(
    Object.entries(scope).map(([name, { columns }]) => [name, { columns, rows: [] }]),
  );
}

/** A value as the replica stores it: times as milliseconds, booleans as 0 or 1, JSON as text. */
function storedValue(value: unknown): SQLiteCompatibleType {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Runs each of the page's queries over an in-memory SQLite database holding the scope's rows, as
 * the replica worker runs them over the replica's relations.
 */
export async function storyResults(
  scope: StoryScope,
  definition: PageDefinition,
): Promise<Record<string, PageQueryState>> {
  const sqlite3 = SQLite.Factory(await SQLiteESMFactory());
  const db = await sqlite3.open_v2(":memory:");
  try {
    const run = async (sql: string, params: SQLiteCompatibleType[] = []) => {
      const result = { columns: [] as string[], rows: [] as SQLiteCompatibleType[][] };
      for await (const statement of sqlite3.statements(db, sql)) {
        if (params.length > 0) {
          sqlite3.bind_collection(statement, params);
        }
        result.columns = sqlite3.column_names(statement);
        while ((await sqlite3.step(statement)) === SQLite.SQLITE_ROW) {
          result.rows.push(sqlite3.row(statement));
        }
      }
      return result;
    };
    for (const [name, { columns, rows }] of Object.entries(scope)) {
      await run(`CREATE TABLE "${name}" (${columns.map((column) => `"${column}"`).join(", ")})`);
      for (const row of rows) {
        await run(
          `INSERT INTO "${name}" VALUES (${columns.map(() => "?").join(", ")})`,
          columns.map((column) => storedValue(row[column])),
        );
      }
    }
    const results: Record<string, PageQueryState> = {};
    for (const [name, query] of Object.entries(definition.queries)) {
      try {
        results[name] = {
          status: "ready",
          result: await run(query.sql, pageQueryParams(query, STORY_NOW).map(storedValue)),
        };
      } catch (error) {
        results[name] = {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return results;
  } finally {
    await sqlite3.close(db);
  }
}
