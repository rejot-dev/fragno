import type { CompiledQuery, Dialect } from "./sql-driver";
import {
  sql as kyselySql,
  type QueryExecutor,
  type CompiledQuery as KyselyCompiledQuery,
} from "kysely";

/**
 * Wrapper around Kysely's RawBuilder that provides a compile() method with a dialect parameter.
 */
export class RawBuilder {
  #kyselyBuilder: ReturnType<typeof kyselySql>;

  constructor(kyselyBuilder: ReturnType<typeof kyselySql>) {
    this.#kyselyBuilder = kyselyBuilder;
  }

  /**
   * Compiles the SQL query using the provided Kysely dialect.
   * Creates a minimal query executor with the dialect's adapter and query compiler.
   *
   * @param dialect - Kysely dialect (e.g., SqliteDialect, PostgresDialect, MysqlDialect)
   * @returns Compiled query with SQL string and parameters
   */
  compile(dialect: Dialect): CompiledQuery {
    const queryCompiler = dialect.createQueryCompiler();

    return this.#kyselyBuilder.compile({
      getExecutor(): QueryExecutor {
        return {
          transformQuery(node, _queryId) {
            return node;
          },
          compileQuery(node, queryId) {
            return queryCompiler.compileQuery(node, queryId) as KyselyCompiledQuery;
          },
          // Kysely's RawBuilder will only call transformQuery and compileQuery if the query is a raw query.
        } as QueryExecutor;
      },
    });
  }
}

/**
 * Tagged template function for building SQL queries with parameters.
 * Wraps Kysely's sql function to provide a compile(dialect: Dialect) method.
 *
 * @example
 * ```ts
 * import { SqliteDialect } from 'kysely';
 *
 * const dialect = new SqliteDialect({ database: ... });
 * const userId = 123;
 * const query = sql`SELECT * FROM users WHERE id = ${userId}`;
 * const compiled = query.compile(dialect);
 * ```
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): RawBuilder {
  const kyselyBuilder = kyselySql(strings, ...values);
  return new RawBuilder(kyselyBuilder);
}
