import type { TableToUpdateValues } from "@fragno-dev/db/query";
import { FragnoId, FragnoReference, type AnySchema, type AnyTable } from "@fragno-dev/db/schema";

import { dbInterval, dbNow } from "@fragno-dev/db";

import type {
  LofiLocalProjection,
  LofiLocalProjectionRead,
  LofiMutation,
  LofiMutationMatcher,
  LofiMutationOp,
  LofiProjectionReadEachBuilder,
  LofiProjectionReadEachRequest,
  LofiProjectionReadPlan,
  LofiProjectionReadRequest,
  LofiProjectionResolved,
  LofiProjectionRowSnapshot,
  LofiProjectionTx,
  LofiTypedMutation,
} from "../types";

export type SchemaMaps = {
  schemaMap: Map<string, AnySchema>;
  tableMap: Map<string, Map<string, AnyTable>>;
};

export const createSchemaMaps = (schemas: readonly AnySchema[], owner: string): SchemaMaps => {
  const schemaMap = new Map<string, AnySchema>();
  const tableMap = new Map<string, Map<string, AnyTable>>();

  for (const schema of schemas) {
    if (!schema.name || schema.name.trim().length === 0) {
      throw new Error(`${owner} schemas must have a non-empty name.`);
    }
    if (schemaMap.has(schema.name)) {
      throw new Error(`${owner} schema name must be unique: ${schema.name}`);
    }

    schemaMap.set(schema.name, schema);
    const tables = new Map<string, AnyTable>();
    for (const [tableName, table] of Object.entries(schema.tables)) {
      tables.set(tableName, table);
    }
    tableMap.set(schema.name, tables);
  }

  return { schemaMap, tableMap };
};

export const mergeSchemaLists = (
  sourceSchemas: readonly AnySchema[],
  localSchemas: readonly AnySchema[],
  owner: string,
): AnySchema[] => {
  const names = new Set<string>();
  const merged: AnySchema[] = [];

  for (const schema of [...sourceSchemas, ...localSchemas]) {
    if (!schema.name || schema.name.trim().length === 0) {
      throw new Error(`${owner} schemas must have a non-empty name.`);
    }
    if (names.has(schema.name)) {
      throw new Error(`${owner} schema name must be unique: ${schema.name}`);
    }
    names.add(schema.name);
    merged.push(schema);
  }

  return merged;
};

export const getKnownMutation = (options: {
  mutation: LofiMutation;
  schemaMap: Map<string, AnySchema>;
  tableMap: Map<string, Map<string, AnyTable>>;
  ignoreUnknownSchemas: boolean;
  schemaErrorPrefix: string;
  tableErrorPrefix: string;
}): { mutation: LofiMutation; schema: AnySchema; table: AnyTable } | undefined => {
  const {
    mutation,
    schemaMap,
    tableMap,
    ignoreUnknownSchemas,
    schemaErrorPrefix,
    tableErrorPrefix,
  } = options;
  const schema = schemaMap.get(mutation.schema);
  if (!schema) {
    if (ignoreUnknownSchemas) {
      return undefined;
    }
    throw new Error(`${schemaErrorPrefix}: ${mutation.schema}`);
  }
  const table = tableMap.get(mutation.schema)?.get(mutation.table);
  if (!table) {
    if (ignoreUnknownSchemas) {
      return undefined;
    }
    throw new Error(`${tableErrorPrefix}: ${mutation.schema}.${mutation.table}`);
  }
  return { mutation, schema, table };
};

export const matchMutation = <
  const TSchema extends AnySchema,
  const TTableName extends keyof TSchema["tables"] & string,
  const TOp extends LofiMutationOp | readonly LofiMutationOp[],
>(
  mutation: LofiMutation,
  schema: TSchema,
  table: TTableName,
  op: TOp,
):
  | LofiTypedMutation<
      TSchema,
      TTableName,
      TOp extends readonly LofiMutationOp[] ? TOp[number] : Extract<TOp, LofiMutationOp>
    >
  | undefined => {
  const matchesOp = Array.isArray(op) ? op.includes(mutation.op) : mutation.op === op;
  if (mutation.schema !== schema.name || mutation.table !== table || !matchesOp) {
    return undefined;
  }
  return mutation as LofiTypedMutation<
    TSchema,
    TTableName,
    TOp extends readonly LofiMutationOp[] ? TOp[number] : Extract<TOp, LofiMutationOp>
  >;
};

export const createMutationMatcher = (mutations: readonly LofiMutation[]): LofiMutationMatcher => ({
  one: matchMutation,
  all: (schema, table, op) =>
    mutations.flatMap((mutation) => {
      const matched = matchMutation(mutation, schema, table, op);
      return matched ? [matched] : [];
    }),
});

export const defineLocalProjection = <
  const TRetrieve extends LofiProjectionReadPlan | void = undefined,
>(
  projection: LofiLocalProjection<TRetrieve>,
): LofiLocalProjection<TRetrieve> => projection;

const createProjectionReadEachBuilder = <TItem>(
  items: readonly TItem[],
): LofiProjectionReadEachBuilder<TItem> => ({
  map<TMapped>(mapper: (item: TItem) => TMapped | undefined | null | false) {
    const mapped = items.flatMap((item) => {
      const mappedItem = mapper(item);
      return mappedItem === undefined || mappedItem === null || mappedItem === false
        ? []
        : [mappedItem];
    });
    return createProjectionReadEachBuilder(mapped as Exclude<TMapped, undefined | null | false>[]);
  },
  get: (schema, tableName, getExternalId) => ({
    type: "lofi.projection.read.each",
    items,
    schema,
    tableName,
    getExternalId,
  }),
});

export const createProjectionReadApi = (): LofiLocalProjectionRead => ({
  get: (schema, tableName, externalId) => ({
    type: "lofi.projection.read.get",
    schema,
    tableName,
    externalId,
  }),
  each: createProjectionReadEachBuilder,
  getEach: (items, schema, tableName, getExternalId) =>
    createProjectionReadEachBuilder(items).get(schema, tableName, getExternalId),
});

export const isProjectionReadRequest = (
  value: unknown,
): value is LofiProjectionReadRequest<unknown> =>
  typeof value === "object" &&
  value !== null &&
  (value as { type?: unknown }).type === "lofi.projection.read.get";

export const isProjectionReadEachRequest = (
  value: unknown,
): value is LofiProjectionReadEachRequest<unknown, unknown> =>
  typeof value === "object" &&
  value !== null &&
  (value as { type?: unknown }).type === "lofi.projection.read.each";

export const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

export const assertSynchronousProjectionResult = (value: unknown, phase: string): void => {
  if (!isThenable(value)) {
    return;
  }

  void Promise.resolve(value).catch(() => {
    // The synchronous projection contract is reported by the caller; consume late rejections.
  });
  throw new Error(`Projection ${phase} must be synchronous.`);
};

export const cloneProjectionRowSnapshot = (
  row: LofiProjectionRowSnapshot,
  endpointName = row.endpoint,
): LofiProjectionRowSnapshot => ({
  key: [endpointName, row.schema, row.table, row.id],
  endpoint: endpointName,
  schema: row.schema,
  table: row.table,
  id: row.id,
  data: { ...row.data },
  _lofi: {
    versionstamp: row._lofi.versionstamp,
    norm: { ...row._lofi.norm },
    internalId: row._lofi.internalId,
    version: row._lofi.version,
  },
});

export const projectionRowToRecord = (
  row: LofiProjectionRowSnapshot,
  table: AnyTable,
): Record<string, unknown> => {
  const record = { ...row.data };
  for (const [columnName, column] of Object.entries(table.columns)) {
    if (column.role === "external-id") {
      record[columnName] = new FragnoId({
        externalId: row.id,
        internalId: BigInt(row._lofi.internalId),
        version: row._lofi.version,
      });
    } else if (column.role === "internal-id") {
      record[columnName] = BigInt(row._lofi.internalId);
    } else if (column.role === "version") {
      record[columnName] = row._lofi.version;
    } else if (column.role === "reference") {
      const value = row._lofi.norm[columnName];
      record[columnName] =
        value === null || value === undefined
          ? null
          : FragnoReference.fromInternal(BigInt(value as number));
    }
  }
  return record;
};

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const resolveProjectionReadPlan = <TPlan extends LofiProjectionReadPlan | void>(
  plan: TPlan,
  resolveRead: (request: LofiProjectionReadRequest<unknown>) => unknown | Promise<unknown>,
): LofiProjectionResolved<TPlan> | Promise<LofiProjectionResolved<TPlan>> => {
  const resolveValue = (value: unknown): unknown | Promise<unknown> => {
    if (isThenable(value)) {
      void Promise.resolve(value).catch(() => {
        // The synchronous projection contract is reported by the caller; consume late rejections.
      });
      throw new Error("Projection retrieve must return read descriptors, not promises.");
    }

    if (isProjectionReadRequest(value)) {
      return resolveRead(value);
    }

    if (isProjectionReadEachRequest(value)) {
      const resolvedItems = value.items.map((item) => {
        const row = resolveRead({
          type: "lofi.projection.read.get",
          schema: value.schema,
          tableName: value.tableName,
          externalId: value.getExternalId(item),
        });
        return isThenable(row)
          ? row.then((resolvedRow) => ({ item, row: resolvedRow }))
          : { item, row };
      });
      return resolvedItems.some(isThenable) ? Promise.all(resolvedItems) : resolvedItems;
    }

    if (Array.isArray(value)) {
      const resolvedItems = value.map((item) => resolveValue(item));
      return resolvedItems.some(isThenable) ? Promise.all(resolvedItems) : resolvedItems;
    }

    if (typeof value === "object" && value !== null && isPlainObject(value)) {
      const entries = Object.entries(value).map(
        ([key, nested]) => [key, resolveValue(nested)] as const,
      );
      if (entries.some(([, nested]) => isThenable(nested))) {
        return Promise.all(entries.map(async ([key, nested]) => [key, await nested] as const)).then(
          (resolvedEntries) => Object.fromEntries(resolvedEntries),
        );
      }
      return Object.fromEntries(entries);
    }

    return value;
  };

  return resolveValue(plan) as
    | LofiProjectionResolved<TPlan>
    | Promise<LofiProjectionResolved<TPlan>>;
};

const getLocalProjectionTarget = (options: {
  schema: AnySchema;
  tableName: string;
  localSchemaMap: Map<string, AnySchema>;
  localTableMap: Map<string, Map<string, AnyTable>>;
  errorPrefix: string;
}): { schema: AnySchema; table: AnyTable } => {
  const { schema, tableName, localSchemaMap, localTableMap, errorPrefix } = options;
  const localSchema = localSchemaMap.get(schema.name);
  if (!localSchema) {
    throw new Error(`${errorPrefix}: ${schema.name}`);
  }
  const table = localTableMap.get(schema.name)?.get(tableName);
  if (!table) {
    throw new Error(`Unknown local projection table: ${schema.name}.${tableName}`);
  }
  return { schema: localSchema, table };
};

export const getLocalMutationTarget = (options: {
  schema: AnySchema;
  tableName: string;
  localSchemaMap: Map<string, AnySchema>;
  localTableMap: Map<string, Map<string, AnyTable>>;
}): { schema: AnySchema; table: AnyTable } =>
  getLocalProjectionTarget({
    ...options,
    errorPrefix: "Projection writes must target a local schema",
  });

export const getLocalReadTarget = (options: {
  schema: AnySchema;
  tableName: string;
  localSchemaMap: Map<string, AnySchema>;
  localTableMap: Map<string, Map<string, AnyTable>>;
}): { schema: AnySchema; table: AnyTable } =>
  getLocalProjectionTarget({
    ...options,
    errorPrefix: "Projection reads must target a local schema",
  });

const getExternalIdValue = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof FragnoId) {
    return value.externalId;
  }
  if (value && typeof value === "object" && "externalId" in value) {
    const externalId = (value as { externalId?: unknown }).externalId;
    return typeof externalId === "string" ? externalId : undefined;
  }
  return undefined;
};

const createProjectionCreateMutation = (options: {
  schema: AnySchema;
  tableName: string;
  table: AnyTable;
  values: Record<string, unknown>;
  versionstamp: string;
}): { mutation: LofiMutation; externalId: string } => {
  const { schema, tableName, table, values, versionstamp } = options;
  const idColumn = table.getIdColumn();
  const providedId = values[idColumn.name];
  const externalId = getExternalIdValue(providedId);

  if (providedId !== undefined && !externalId) {
    throw new Error(`Invalid projection ID for ${schema.name}.${tableName}.${idColumn.name}`);
  }

  const generatedExternalId = externalId ?? getExternalIdValue(idColumn.generateDefaultValue());
  if (!generatedExternalId) {
    throw new Error(
      `No projection ID provided and ${schema.name}.${tableName}.${idColumn.name} has no runtime default`,
    );
  }

  const mutationValues = externalId
    ? values
    : {
        ...values,
        [idColumn.name]: generatedExternalId,
      };

  return {
    externalId: generatedExternalId,
    mutation: {
      op: "create",
      schema: schema.name,
      table: tableName,
      externalId: generatedExternalId,
      values: mutationValues,
      versionstamp,
    },
  };
};

const toExternalId = (value: string | FragnoId): string =>
  typeof value === "string" ? value : value.externalId;

export type ProjectionQueuedMutation = LofiMutation & {
  checkVersion?: boolean;
  expectedVersion?: number;
};

class ProjectionUpdateBuilder<TTable extends AnyTable> {
  readonly #tableName: string;
  readonly #id: string | FragnoId;
  #setValues?: TableToUpdateValues<TTable>;
  #checkVersion = false;

  constructor(tableName: string, id: string | FragnoId) {
    this.#tableName = tableName;
    this.#id = id;
  }

  set(values: TableToUpdateValues<TTable>): this {
    this.#setValues = values;
    return this;
  }

  check(): this {
    if (typeof this.#id === "string") {
      throw new Error(
        `Cannot use check() with a string ID on table "${this.#tableName}". ` +
          `Version checking requires a FragnoId with version information.`,
      );
    }
    this.#checkVersion = true;
    return this;
  }

  now() {
    return dbNow();
  }

  interval(input: Parameters<typeof dbInterval>[0]) {
    return dbInterval(input);
  }

  build(tableLabel: string): { set: TableToUpdateValues<TTable>; checkVersion: boolean } {
    if (!this.#setValues) {
      throw new Error(
        `Must specify values using .set() before finalizing projection update on ${tableLabel}`,
      );
    }
    return { set: this.#setValues, checkVersion: this.#checkVersion };
  }
}

export const createProjectionTx = (options: {
  versionstamp: string;
  localSchemaMap: Map<string, AnySchema>;
  localTableMap: Map<string, Map<string, AnyTable>>;
}): LofiProjectionTx & { drainMutations(): ProjectionQueuedMutation[] } => {
  const { versionstamp, localSchemaMap, localTableMap } = options;
  const mutations: ProjectionQueuedMutation[] = [];

  return {
    forSchema(schema) {
      const localSchema = localSchemaMap.get(schema.name);
      if (!localSchema) {
        throw new Error(`Projection writes must target a local schema: ${schema.name}`);
      }

      return {
        create(tableName, values) {
          const target = getLocalMutationTarget({
            schema: localSchema,
            tableName,
            localSchemaMap,
            localTableMap,
          });
          const { mutation, externalId } = createProjectionCreateMutation({
            schema: target.schema,
            tableName,
            table: target.table,
            values: values as Record<string, unknown>,
            versionstamp,
          });
          mutations.push(mutation);
          return FragnoId.fromExternal(externalId, 0);
        },
        update(tableName, externalId, builderFn) {
          const target = getLocalMutationTarget({
            schema: localSchema,
            tableName,
            localSchemaMap,
            localTableMap,
          });
          const builder = new ProjectionUpdateBuilder(tableName, externalId);
          builderFn(builder);
          const built = builder.build(`${target.schema.name}.${tableName}`);
          mutations.push({
            op: "update",
            schema: target.schema.name,
            table: tableName,
            externalId: toExternalId(externalId),
            set: built.set as Record<string, unknown>,
            checkVersion: built.checkVersion,
            expectedVersion: externalId instanceof FragnoId ? externalId.version : undefined,
            versionstamp,
          });
        },
        delete(tableName, externalId) {
          const target = getLocalMutationTarget({
            schema: localSchema,
            tableName,
            localSchemaMap,
            localTableMap,
          });
          mutations.push({
            op: "delete",
            schema: target.schema.name,
            table: tableName,
            externalId: toExternalId(externalId),
            versionstamp,
          });
        },
      };
    },
    drainMutations() {
      return mutations.splice(0, mutations.length);
    },
  };
};
