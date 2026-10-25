import type { AnySchema, AnyTable } from "@fragno-dev/db/schema";

import type {
  AnyLofiLocalProjection,
  LofiLocalProjectionRead,
  LofiMutation,
  LofiProjectionReadRequest,
} from "../types";
import {
  assertSynchronousProjectionResult,
  createMutationMatcher,
  createProjectionReadApi,
  createProjectionTx,
  getLocalMutationTarget,
  getLocalReadTarget,
  isThenable,
  resolveLofiSchemaName,
  resolveProjectionReadPlan,
  type LofiSchemaNameAliases,
  type ProjectionQueuedMutation,
} from "./projection";

export type LocalProjectionTarget = { schema: AnySchema; table: AnyTable };

/**
 * Runs every projection against one batch of applied source mutations. Storage stays with the
 * adapter: `readRow` returns a decoded local record and `writeMutation` persists one projection
 * write, including its version check, inside the adapter's current transaction.
 */
export async function runLocalProjections(options: {
  projections: readonly AnyLofiLocalProjection[];
  mutations: readonly LofiMutation[];
  source: { sourceKey?: string; uowId?: string; versionstamp: string };
  localSchemaMap: Map<string, AnySchema>;
  localTableMap: Map<string, Map<string, AnyTable>>;
  schemaNameAliases: LofiSchemaNameAliases;
  readRow: (
    target: LocalProjectionTarget,
    externalId: string,
  ) => Promise<Record<string, unknown> | undefined>;
  writeMutation: (
    mutation: ProjectionQueuedMutation,
    target: LocalProjectionTarget,
  ) => Promise<void>;
}): Promise<void> {
  const { projections, mutations, source, localSchemaMap, localTableMap, schemaNameAliases } =
    options;
  if (projections.length === 0 || mutations.length === 0) {
    return;
  }

  const read: LofiLocalProjectionRead = createProjectionReadApi();
  const projectionSource = {
    sourceKey: source.sourceKey,
    uowId: source.uowId,
    versionstamp: source.versionstamp,
  };
  const match = createMutationMatcher(mutations, schemaNameAliases);

  const resolveRead = ({
    schema,
    tableName,
    externalId,
  }: LofiProjectionReadRequest<unknown>): Promise<Record<string, unknown> | undefined> =>
    options.readRow(
      getLocalReadTarget({ schema, tableName, localSchemaMap, localTableMap, schemaNameAliases }),
      externalId,
    );

  const writeMutation = async (
    projection: AnyLofiLocalProjection,
    mutation: ProjectionQueuedMutation,
  ): Promise<void> => {
    const targetSchema = localSchemaMap.get(
      resolveLofiSchemaName(mutation.schema, schemaNameAliases),
    );
    if (!targetSchema) {
      throw new Error(`Projection writes must target a local schema: ${mutation.schema}`);
    }
    const target = getLocalMutationTarget({
      schema: targetSchema,
      tableName: mutation.table,
      localSchemaMap,
      localTableMap,
      schemaNameAliases,
    });
    // A rebuild empties only the tables the projection declares, so it may write no others.
    if (
      projection.rebuild &&
      !projection.rebuild.writes.some(
        ({ schema, table }) =>
          resolveLofiSchemaName(schema.name, schemaNameAliases) === target.schema.name &&
          table === target.table.name,
      )
    ) {
      throw new Error(
        `Projection ${projection.name ?? "(unnamed)"} writes ${target.schema.name}.${target.table.name}, which its rebuild does not list.`,
      );
    }
    await options.writeMutation(mutation, target);
  };

  for (const projection of projections) {
    let retrieved: unknown;
    if (projection.retrieve) {
      const readPlan = projection.retrieve({
        mutations,
        source: projectionSource,
        match,
        read,
      });
      assertSynchronousProjectionResult(readPlan, "retrieve");
      if (readPlan === undefined) {
        continue;
      }
      const resolved: unknown = resolveProjectionReadPlan(readPlan, resolveRead);
      retrieved = isThenable(resolved) ? await resolved : resolved;
    }

    const tx = createProjectionTx({
      versionstamp: source.versionstamp,
      localSchemaMap,
      localTableMap,
      schemaNameAliases,
    });
    const mutateResult = projection.mutate({
      mutations,
      source: projectionSource,
      match,
      retrieved,
      tx,
    });
    assertSynchronousProjectionResult(mutateResult, "mutate");
    for (const projectionMutation of tx.drainMutations()) {
      await writeMutation(projection, projectionMutation);
    }
  }
}
