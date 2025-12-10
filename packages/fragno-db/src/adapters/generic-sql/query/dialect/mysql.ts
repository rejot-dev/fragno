import { SQLQueryCompiler } from "../sql-query-compiler";

/**
 * MySQL-specific query compiler.
 *
 * MySQL does not support RETURNING clause, so inserts return empty results.
 */
export class MySQLQueryCompiler extends SQLQueryCompiler {
  /**
   * MySQL uses standard .limit()
   */
  protected applyLimit<T>(query: T & { limit(limit: number): T }, limit: number): T {
    return query.limit(limit);
  }

  /**
   * MySQL uses standard .offset()
   */
  protected applyOffset<T>(query: T & { offset(offset: number): T }, offset: number): T {
    return query.offset(offset);
  }

  /**
   * MySQL does not support RETURNING clause.
   * Return the query as-is without RETURNING.
   */
  protected applyReturning<T>(
    query: T & { returning(columns: string[]): T },
    _columns: string[],
  ): T {
    // MySQL doesn't support RETURNING, just return the query unchanged
    return query;
  }
}
