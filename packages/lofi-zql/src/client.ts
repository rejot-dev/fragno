import type { AnySchema } from "@fragno-dev/db/schema";
import {
  registeredSchemaName,
  type LofiSqliteClient,
  type LofiSqliteView,
} from "@fragno-dev/lofi/sqlite";

import { lofiZqlSchema, type LofiZqlSchema } from "./schema";
import { createBuilder } from "./vendor/zql/src/query/create-builder.ts";
import { asQueryInternals } from "./vendor/zql/src/query/query-internals.ts";
import type { HumanReadable, Query } from "./vendor/zql/src/query/query.ts";
import type { SchemaQuery } from "./vendor/zql/src/query/schema-query.ts";
import { ZQL_VIEW_KIND, type LofiZqlViewQuery } from "./view-query";

export type LofiZqlSchemaClient<TSchema extends AnySchema> = {
  /** Starts ZQL queries on the schema's tables. */
  readonly query: SchemaQuery<LofiZqlSchema<TSchema>>;
  /**
   * A store of the query's live result, which the replica worker maintains incrementally while the
   * store has listeners. The worker's `engines` must include `zqlViewEngine`.
   */
  store<TTable extends keyof TSchema["tables"] & string, TReturn>(
    query: Query<TTable, LofiZqlSchema<TSchema>, TReturn>,
  ): LofiSqliteView<HumanReadable<TReturn>>;
};

/** Queries one of the replica's schemas with ZQL. */
export function lofiZql<const TSchema extends AnySchema>(
  replica: LofiSqliteClient,
  schema: TSchema,
): LofiZqlSchemaClient<TSchema> {
  const registration = replica.schemas.find((candidate) => candidate.schema === schema);
  if (!registration) {
    throw new Error(`Schema "${schema.name}" is not one of the replica's schemas.`);
  }
  const schemaName = registeredSchemaName(registration);
  return {
    query: createBuilder(lofiZqlSchema(schema)),
    store(query) {
      const { ast, format } = asQueryInternals(query);
      const viewQuery: LofiZqlViewQuery = { schemaName, ast, format };
      return replica.view(ZQL_VIEW_KIND, viewQuery);
    },
  };
}
