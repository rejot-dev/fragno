import { SQLQueryCompiler } from "../sql-query-compiler";

/**
 * SQLite-specific query compiler.
 *
 * SQLite supports RETURNING and uses standard limit/offset.
 */
export class SQLiteQueryCompiler extends SQLQueryCompiler {
  /**
   * SQLite uses standard .limit()
   */
  protected applyLimit<T>(query: T & { limit(limit: number): T }, limit: number): T {
    return query.limit(limit);
  }

  /**
   * SQLite uses standard .offset()
   */
  protected applyOffset<T>(query: T & { offset(offset: number): T }, offset: number): T {
    return query.offset(offset);
  }

  /**
   * SQLite supports RETURNING clause (since version 3.35.0)
   */
  protected applyReturning<T>(
    query: T & { returning(columns: string[]): T },
    columns: string[],
  ): T {
    return query.returning(columns);
  }
}
