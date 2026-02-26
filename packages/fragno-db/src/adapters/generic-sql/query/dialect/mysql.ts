import { sql } from "kysely";
import type { AnyTable } from "../../../../schema/create";
import type { UpsertCompilerOptions } from "../sql-query-compiler";
import { SQLQueryCompiler } from "../sql-query-compiler";

/**
 * MySQL-specific query compiler.
 *
 * MySQL does not support RETURNING clause, so inserts return empty results.
 */
export class MySQLQueryCompiler extends SQLQueryCompiler {
  override compileUpsert(table: AnyTable, options: UpsertCompilerOptions) {
    const encodedValues = this.encoder.encodeForDatabase({
      values: options.values,
      table,
      generateDefaults: true,
    });

    let insert = this.db.insertInto(this.getTableName(table)).values(encodedValues);

    const updateValues = this.encoder.encodeForDatabase({
      values: options.values,
      table,
      generateDefaults: false,
    });

    const idColumn = table.getIdColumn();
    const idColumnName = this.resolver
      ? this.resolver.getColumnName(table.name, idColumn.name)
      : idColumn.name;
    if (idColumnName in updateValues) {
      delete updateValues[idColumnName];
    }

    const versionCol = table.getVersionColumn();
    const versionColumnName = this.resolver
      ? this.resolver.getColumnName(table.name, versionCol.name)
      : versionCol.name;
    updateValues[versionColumnName] = sql`coalesce(${sql.ref(versionColumnName)}, 0) + 1`;

    updateValues[idColumnName] = sql`if(${sql.ref(idColumnName)} = values(${sql.ref(
      idColumnName,
    )}), ${sql.ref(idColumnName)}, null)`;

    insert = insert.onDuplicateKeyUpdate(updateValues);

    return insert.compile();
  }

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
