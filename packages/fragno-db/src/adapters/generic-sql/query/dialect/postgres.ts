import { SQLQueryCompiler } from "../sql-query-compiler";

/**
 * PostgreSQL-specific query compiler.
 *
 * Uses standard SQL with full RETURNING support.
 */
export class PostgreSQLQueryCompiler extends SQLQueryCompiler {
  /**
   * PostgreSQL uses standard .limit()
   */
  protected applyLimit<T>(query: T & { limit(limit: number): T }, limit: number): T {
    return query.limit(limit);
  }

  /**
   * PostgreSQL uses standard .offset()
   */
  protected applyOffset<T>(query: T & { offset(offset: number): T }, offset: number): T {
    return query.offset(offset);
  }

  /**
   * PostgreSQL supports full RETURNING clause
   */
  protected applyReturning<T>(
    query: T & { returning(columns: string[]): T },
    columns: string[],
  ): T {
    return query.returning(columns);
  }
}
