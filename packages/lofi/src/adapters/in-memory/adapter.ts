import type { AnySchema, AnyTable } from "@fragno-dev/db/schema";

import {
  assertSynchronousProjectionResult,
  cloneProjectionRowSnapshot,
  createMutationMatcher,
  createProjectionReadApi,
  createProjectionTx,
  createSchemaMaps,
  getKnownMutation,
  getLocalMutationTarget,
  getLocalReadTarget,
  isThenable,
  mergeSchemaLists,
  projectionRowToRecord,
  resolveProjectionReadPlan,
  type ProjectionQueuedMutation,
} from "../../local/projection";
import { resolveMutationValues, resolveMutations } from "../../query/mutation-values";
import type {
  AnyLofiLocalProjection,
  InMemoryLofiAdapterOptions,
  LofiAdapter,
  LofiLocalProjectionRead,
  LofiMutation,
  LofiProjectionReadRequest,
  LofiProjectionRowLookup,
  LofiProjectionRowSnapshot,
  LofiQueryEngineOptions,
  LofiQueryInterface,
  LofiQueryableAdapter,
} from "../../types";
import { createInMemoryQueryEngine } from "./query";
import { InMemoryLofiStore } from "./store";

type InboxRow = {
  sourceKey: string;
  uowId: string;
  versionstamp: string;
  receivedAt: number;
};

type InMemoryProjectionReadFallback = {
  getRow(options: {
    schemaName: string;
    tableName: string;
    externalId: string;
  }): LofiProjectionRowSnapshot | undefined | Promise<LofiProjectionRowSnapshot | undefined>;
};

type InMemoryApplyMutationsOptions = {
  projectionMutations?: LofiMutation[];
  projectionReadFallback?: InMemoryProjectionReadFallback;
};

const materializeProjectionMutation = (
  mutation: ProjectionQueuedMutation,
  baseNow: number,
): LofiMutation => {
  if (mutation.op === "create") {
    const { op, schema, table, externalId, values, versionstamp } = mutation;
    return {
      op,
      schema,
      table,
      externalId,
      values: resolveMutationValues(values, baseNow),
      versionstamp,
    };
  }
  if (mutation.op === "update") {
    const { op, schema, table, externalId, set, versionstamp } = mutation;
    return {
      op,
      schema,
      table,
      externalId,
      set: resolveMutationValues(set, baseNow),
      versionstamp,
    };
  }
  const { op, schema, table, externalId, versionstamp } = mutation;
  return { op, schema, table, externalId, versionstamp };
};

const rowDataForOverlayCreate = (
  row: LofiProjectionRowSnapshot,
  table: AnyTable,
): Record<string, unknown> => {
  const values = { ...row.data };
  const idColumnName = table.getIdColumn().name;
  if (!(idColumnName in values)) {
    values[idColumnName] = row.id;
  }
  return values;
};

export class InMemoryLofiAdapter
  implements LofiAdapter, LofiQueryableAdapter, LofiProjectionRowLookup
{
  readonly endpointName: string;
  readonly schemas: AnySchema[];
  readonly localSchemas: AnySchema[];
  readonly store: InMemoryLofiStore;
  private readonly schemaMap: Map<string, AnySchema>;
  private readonly tableMap: Map<string, Map<string, AnyTable>>;
  private readonly localSchemaMap: Map<string, AnySchema>;
  private readonly localTableMap: Map<string, Map<string, AnyTable>>;
  private readonly projections: AnyLofiLocalProjection[];
  private readonly ignoreUnknownSchemas: boolean;
  private readonly meta = new Map<string, string>();
  private readonly inbox = new Map<string, InboxRow>();

  constructor(options: InMemoryLofiAdapterOptions) {
    if (!options.endpointName || options.endpointName.trim().length === 0) {
      throw new Error("InMemoryLofiAdapter requires a non-empty endpointName.");
    }

    const sourceSchemas = options.schemas;
    const localSchemas = options.localSchemas ?? [];
    const allSchemas = mergeSchemaLists(sourceSchemas, localSchemas, "InMemoryLofiAdapter");
    const { schemaMap, tableMap } = createSchemaMaps(sourceSchemas, "InMemoryLofiAdapter");
    const { schemaMap: localSchemaMap, tableMap: localTableMap } = createSchemaMaps(
      localSchemas,
      "InMemoryLofiAdapter local",
    );

    this.endpointName = options.endpointName;
    this.schemas = [...schemaMap.values()];
    this.localSchemas = [...localSchemaMap.values()];
    this.schemaMap = schemaMap;
    this.tableMap = tableMap;
    this.localSchemaMap = localSchemaMap;
    this.localTableMap = localTableMap;
    this.projections = options.projections ?? [];
    this.ignoreUnknownSchemas = options.ignoreUnknownSchemas ?? false;
    this.store =
      options.store ??
      new InMemoryLofiStore({
        endpointName: this.endpointName,
        schemas: allSchemas,
      });
  }

  async applyOutboxEntry(options: {
    sourceKey: string;
    versionstamp: string;
    uowId: string;
    mutations: LofiMutation[];
  }): Promise<{ applied: boolean }> {
    const inboxKey = `${options.sourceKey}::${options.uowId}::${options.versionstamp}`;
    if (this.inbox.has(inboxKey)) {
      return { applied: false };
    }

    const knownMutations: LofiMutation[] = [];
    for (const mutation of options.mutations) {
      const known = getKnownMutation({
        mutation,
        schemaMap: this.schemaMap,
        tableMap: this.tableMap,
        ignoreUnknownSchemas: this.ignoreUnknownSchemas,
        schemaErrorPrefix: "Unknown outbox schema",
        tableErrorPrefix: "Unknown outbox table",
      });
      if (known) {
        knownMutations.push(known.mutation);
      }
    }

    const baseNow = Date.now();
    const materializedKnownMutations = resolveMutations(knownMutations, baseNow);
    const projectionMutations = await this.collectProjectionMutations(materializedKnownMutations, {
      sourceKey: options.sourceKey,
      uowId: options.uowId,
      versionstamp: options.versionstamp,
      baseNow,
    });
    if (materializedKnownMutations.length > 0 || projectionMutations.length > 0) {
      this.store.applyMutations([...materializedKnownMutations, ...projectionMutations]);
    }

    this.inbox.set(inboxKey, {
      sourceKey: options.sourceKey,
      uowId: options.uowId,
      versionstamp: options.versionstamp,
      receivedAt: Date.now(),
    });

    return { applied: true };
  }

  async applyMutations(
    mutations: LofiMutation[],
    options?: InMemoryApplyMutationsOptions,
  ): Promise<void> {
    if (mutations.length === 0) {
      return;
    }

    const baseNow = Date.now();
    const knownMutations = resolveMutations(
      this.getKnownMutations(mutations, "Unknown mutation schema", "Unknown mutation table"),
      baseNow,
    );
    const knownProjectionMutations = options?.projectionMutations
      ? resolveMutations(
          this.getKnownMutations(
            options.projectionMutations,
            "Unknown mutation schema",
            "Unknown mutation table",
          ),
          baseNow,
        )
      : knownMutations;

    const projectionVersionstamp =
      knownProjectionMutations.at(-1)?.versionstamp ??
      knownMutations.at(-1)?.versionstamp ??
      "local";
    const projectionMutations = await this.collectProjectionMutations(knownProjectionMutations, {
      versionstamp: projectionVersionstamp,
      baseNow,
      projectionReadFallback: options?.projectionReadFallback,
    });
    if (knownMutations.length > 0 || projectionMutations.length > 0) {
      this.store.applyMutations([...knownMutations, ...projectionMutations]);
    }
  }

  async getMeta(key: string): Promise<string | undefined> {
    return this.meta.get(key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
  }

  createQueryEngine<const T extends AnySchema>(
    schema: T,
    options?: LofiQueryEngineOptions,
  ): LofiQueryInterface<T> {
    return createInMemoryQueryEngine({
      schema,
      store: this.store,
      schemaName: options?.schemaName,
    });
  }

  getProjectionRow(options: {
    schemaName: string;
    tableName: string;
    externalId: string;
  }): LofiProjectionRowSnapshot | undefined {
    const row = this.store.getRow(options.schemaName, options.tableName, options.externalId);
    return row ? cloneProjectionRowSnapshot(row) : undefined;
  }

  private getKnownMutations(
    mutations: LofiMutation[],
    schemaErrorPrefix: string,
    tableErrorPrefix: string,
  ): LofiMutation[] {
    const knownMutations: LofiMutation[] = [];
    for (const mutation of mutations) {
      const known = getKnownMutation({
        mutation,
        schemaMap: this.schemaMap,
        tableMap: this.tableMap,
        ignoreUnknownSchemas: this.ignoreUnknownSchemas,
        schemaErrorPrefix,
        tableErrorPrefix,
      });
      if (known) {
        knownMutations.push(known.mutation);
      }
    }
    return knownMutations;
  }

  private async collectProjectionMutations(
    mutations: LofiMutation[],
    source: {
      sourceKey?: string;
      uowId?: string;
      versionstamp: string;
      baseNow: number;
      projectionReadFallback?: InMemoryProjectionReadFallback;
    },
  ): Promise<LofiMutation[]> {
    if (this.projections.length === 0 || mutations.length === 0) {
      return [];
    }

    const localStage = new InMemoryLofiStore({
      endpointName: this.endpointName,
      schemas: this.localSchemas,
    });
    const rowOrigins = new Map<string, "store" | "fallback">();
    const fallbackLoads = new Map<string, Promise<LofiProjectionRowSnapshot | undefined>>();
    const rowKey = (schemaName: string, tableName: string, externalId: string) =>
      `${schemaName}\0${tableName}\0${externalId}`;

    for (const schema of this.localSchemas) {
      for (const table of Object.values(schema.tables)) {
        const rows = this.store.getTableRows(schema.name, table.name);
        localStage.seedRows(rows);
        for (const row of rows) {
          rowOrigins.set(rowKey(schema.name, table.name, row.id), "store");
        }
      }
    }

    const projectionMutations: LofiMutation[] = [];
    const projectionSource = {
      sourceKey: source.sourceKey,
      uowId: source.uowId,
      versionstamp: source.versionstamp,
    };
    const read: LofiLocalProjectionRead = createProjectionReadApi();
    const match = createMutationMatcher(mutations);

    const ensureStageRow = async (options: {
      schemaName: string;
      tableName: string;
      externalId: string;
    }): Promise<LofiProjectionRowSnapshot | undefined> => {
      const { schemaName, tableName, externalId } = options;
      const staged = localStage.getRow(schemaName, tableName, externalId);
      if (staged) {
        return staged;
      }
      if (localStage.hasTombstone(schemaName, tableName, externalId)) {
        return undefined;
      }
      if (this.store.hasTombstone(schemaName, tableName, externalId)) {
        return undefined;
      }
      if (!source.projectionReadFallback) {
        return undefined;
      }

      const key = rowKey(schemaName, tableName, externalId);
      let load = fallbackLoads.get(key);
      if (!load) {
        load = (async () => {
          const fallbackRow = await source.projectionReadFallback?.getRow({
            schemaName,
            tableName,
            externalId,
          });
          if (!fallbackRow) {
            return undefined;
          }
          if (localStage.hasTombstone(schemaName, tableName, externalId)) {
            return undefined;
          }
          const alreadyStaged = localStage.getRow(schemaName, tableName, externalId);
          if (alreadyStaged) {
            return alreadyStaged;
          }
          localStage.seedRows([cloneProjectionRowSnapshot(fallbackRow, this.endpointName)]);
          rowOrigins.set(key, "fallback");
          return localStage.getRow(schemaName, tableName, externalId);
        })();
        fallbackLoads.set(key, load);
      }
      return load;
    };

    const resolveRead = async ({
      schema,
      tableName,
      externalId,
    }: LofiProjectionReadRequest<unknown>): Promise<unknown> => {
      const target = getLocalReadTarget({
        schema,
        tableName,
        localSchemaMap: this.localSchemaMap,
        localTableMap: this.localTableMap,
      });
      const row = await ensureStageRow({
        schemaName: target.schema.name,
        tableName,
        externalId,
      });
      return row ? projectionRowToRecord(row, target.table) : undefined;
    };

    const writeMutation = async (mutation: ProjectionQueuedMutation): Promise<void> => {
      const targetSchema = this.localSchemaMap.get(mutation.schema);
      if (!targetSchema) {
        throw new Error(`Projection writes must target a local schema: ${mutation.schema}`);
      }
      const target = getLocalMutationTarget({
        schema: targetSchema,
        tableName: mutation.table,
        localSchemaMap: this.localSchemaMap,
        localTableMap: this.localTableMap,
      });
      const key = rowKey(target.schema.name, mutation.table, mutation.externalId);
      const existing =
        mutation.op === "update"
          ? await ensureStageRow({
              schemaName: target.schema.name,
              tableName: mutation.table,
              externalId: mutation.externalId,
            })
          : localStage.getRow(target.schema.name, mutation.table, mutation.externalId);
      const originBeforeWrite = existing ? rowOrigins.get(key) : undefined;

      if (mutation.op === "update" && mutation.checkVersion) {
        if (!existing || existing._lofi.version !== mutation.expectedVersion) {
          throw new Error(
            `Projection update check failed: ${target.schema.name}.${mutation.table}.${mutation.externalId}`,
          );
        }
      }

      const materialized = materializeProjectionMutation(mutation, source.baseNow);
      localStage.applyMutation(materialized);

      if (materialized.op === "update" && originBeforeWrite === "fallback") {
        const updated = localStage.getRow(target.schema.name, mutation.table, mutation.externalId);
        if (updated) {
          projectionMutations.push({
            op: "create",
            schema: materialized.schema,
            table: materialized.table,
            externalId: materialized.externalId,
            values: rowDataForOverlayCreate(updated, target.table),
            versionstamp: materialized.versionstamp,
          });
          rowOrigins.set(key, "store");
          return;
        }
      }

      projectionMutations.push(materialized);
      if (materialized.op === "delete") {
        rowOrigins.delete(key);
      } else if (localStage.getRow(target.schema.name, mutation.table, mutation.externalId)) {
        rowOrigins.set(key, "store");
      }
    };

    for (const projection of this.projections) {
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
        const resolved = resolveProjectionReadPlan(readPlan, resolveRead);
        retrieved = isThenable(resolved) ? await resolved : resolved;
      }

      const tx = createProjectionTx({
        versionstamp: source.versionstamp,
        localSchemaMap: this.localSchemaMap,
        localTableMap: this.localTableMap,
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
        await writeMutation(projectionMutation);
      }
    }

    return projectionMutations;
  }

  clear(): void {
    this.store.clear();
    this.inbox.clear();
  }

  reset(): void {
    this.clear();
  }
}
