import type { AnyColumn, AnySchema, AnyTable } from "@fragno-dev/db/schema";
import { FragnoId, FragnoReference } from "@fragno-dev/db/schema";
import type { CursorResult } from "@fragno-dev/db/cursor";
import { Cursor, createCursorFromRecord, decodeCursor } from "@fragno-dev/db/cursor";
import { FindBuilder } from "@fragno-dev/db/unit-of-work";
import type { LofiQueryInterface, LofiQueryableAdapter } from "../../types";
import type { Condition } from "../../query/conditions";
import { normalizeValue } from "../../query/normalize";
import { compareNormalizedValues } from "../in-memory/value-comparison";
import type { InMemoryLofiAdapter } from "../in-memory/adapter";
import type { InMemoryLofiRow } from "../in-memory/store";

type CompiledJoin = {
  relation: { name: string; table: AnyTable; on: [string, string][] };
  options:
    | {
        select: unknown;
        where?: unknown;
        orderBy?: [AnyColumn, "asc" | "desc"][];
        join?: CompiledJoin[];
        limit?: number;
      }
    | false;
};

type BuiltFindOptions = {
  useIndex: string;
  select?: unknown;
  where?: unknown;
  orderByIndex?: {
    indexName: string;
    direction: "asc" | "desc";
  };
  after?: Cursor | string;
  before?: Cursor | string;
  pageSize?: number;
  joins?: CompiledJoin[];
};

const buildFindBuilder = <TTable extends AnyTable>(tableName: string, table: TTable) =>
  new FindBuilder<TTable>(tableName, table);

const buildOrderColumns = (table: AnyTable, indexName: string): AnyColumn[] => {
  if (indexName === "_primary") {
    return [table.getIdColumn()];
  }

  const index = table.indexes[indexName];
  const columns = index ? [...index.columns] : [table.getIdColumn()];
  const idColumn = table.getIdColumn();
  if (!columns.some((col) => col.name === idColumn.name)) {
    columns.push(idColumn);
  }
  return columns;
};

const coerceLocalInternalId = (value: unknown): number | null => {
  if (value == null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : null;
  }
  return null;
};

const resolveOrderValue = (value: unknown, column: AnyColumn): unknown => {
  if (column.role === "external-id") {
    if (
      value &&
      typeof value === "object" &&
      "externalId" in value &&
      typeof (value as { externalId?: unknown }).externalId === "string"
    ) {
      return (value as { externalId: string }).externalId;
    }
    return value;
  }

  if (column.role === "internal-id" || column.role === "reference") {
    if (value instanceof FragnoReference) {
      return coerceLocalInternalId(value.internalId);
    }
    if (value instanceof FragnoId) {
      return coerceLocalInternalId(value.internalId);
    }
    return coerceLocalInternalId(value);
  }

  return normalizeValue(value, column);
};

const compareRows = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  orderColumns: AnyColumn[],
  direction: "asc" | "desc",
): number => {
  for (const column of orderColumns) {
    const leftValue = resolveOrderValue(left[column.name], column);
    const rightValue = resolveOrderValue(right[column.name], column);
    const comparison = compareNormalizedValues(leftValue, rightValue);
    if (comparison !== 0) {
      return direction === "asc" ? comparison : -comparison;
    }
  }
  return 0;
};

const buildCursorValues = (
  cursor: Cursor | string | undefined,
  columns: AnyColumn[],
): readonly unknown[] | undefined => {
  if (!cursor) {
    return undefined;
  }

  const cursorObj = typeof cursor === "string" ? decodeCursor(cursor) : cursor;
  return columns.map((column) => resolveOrderValue(cursorObj.indexValues[column.name], column));
};

const compareRowToCursor = (
  row: Record<string, unknown>,
  orderColumns: AnyColumn[],
  cursorValues: readonly unknown[],
): number => {
  for (let i = 0; i < orderColumns.length; i += 1) {
    const column = orderColumns[i]!;
    const rowValue = resolveOrderValue(row[column.name], column);
    const cursorValue = cursorValues[i];
    const comparison = compareNormalizedValues(rowValue, cursorValue);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
};

const applyCursorFilters = (options: {
  rows: Record<string, unknown>[];
  orderColumns: AnyColumn[];
  direction: "asc" | "desc";
  after?: Cursor | string;
  before?: Cursor | string;
}): Record<string, unknown>[] => {
  const { rows, orderColumns, direction, after, before } = options;
  const afterValues = buildCursorValues(after, orderColumns);
  const beforeValues = buildCursorValues(before, orderColumns);

  return rows.filter((row) => {
    if (afterValues) {
      const comparison = compareRowToCursor(row, orderColumns, afterValues);
      if (direction === "asc" ? comparison <= 0 : comparison >= 0) {
        return false;
      }
    }

    if (beforeValues) {
      const comparison = compareRowToCursor(row, orderColumns, beforeValues);
      if (direction === "asc" ? comparison >= 0 : comparison <= 0) {
        return false;
      }
    }

    return true;
  });
};

const getExternalIdFromRow = (row: Record<string, unknown>, table: AnyTable): string | null => {
  const idColumn = table.getIdColumn();
  const value = row[idColumn.name];
  if (value == null) {
    return null;
  }
  if (value instanceof FragnoId) {
    return value.externalId;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && "externalId" in value) {
    const ext = (value as { externalId?: unknown }).externalId;
    if (typeof ext === "string") {
      return ext;
    }
  }
  return null;
};

const buildOutputFromLofiRow = (
  row: InMemoryLofiRow,
  table: AnyTable,
  select: undefined | true | readonly string[],
): Record<string, unknown> => {
  const output: Record<string, unknown> = {};
  const columnNames = select && select !== true ? select : (Object.keys(table.columns) as string[]);

  for (const columnName of columnNames) {
    const column = table.columns[columnName];
    if (!column || column.isHidden) {
      continue;
    }

    if (column.role === "external-id") {
      output[column.name] = new FragnoId({
        externalId: row.id,
        internalId: BigInt(row._lofi.internalId),
        version: row._lofi.version,
      });
      continue;
    }

    if (column.role === "reference") {
      const value = row._lofi.norm[column.name];
      output[column.name] =
        value === null || value === undefined
          ? null
          : FragnoReference.fromInternal(BigInt(value as number));
      continue;
    }

    if (column.role === "internal-id") {
      output[column.name] = BigInt(row._lofi.internalId);
      continue;
    }

    if (column.role === "version") {
      output[column.name] = row._lofi.version;
      continue;
    }

    output[column.name] = row.data[column.name];
  }

  return output;
};

const mergeRowColumns = (
  baseRow: Record<string, unknown>,
  overlayRow: Record<string, unknown>,
  table: AnyTable,
  select: undefined | true | readonly string[],
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...baseRow };
  const columnNames = select && select !== true ? select : (Object.keys(table.columns) as string[]);

  for (const columnName of columnNames) {
    if (!table.columns[columnName]) {
      continue;
    }
    if (columnName in overlayRow) {
      merged[columnName] = overlayRow[columnName];
    }
  }

  return merged;
};

const patchJoinRows = (options: {
  row: Record<string, unknown>;
  joins: CompiledJoin[] | undefined;
  overlay: InMemoryLofiAdapter;
  schemaName: string;
}): void => {
  const { row, joins, overlay, schemaName } = options;
  if (!joins || joins.length === 0) {
    return;
  }

  for (const join of joins) {
    if (join.options === false) {
      continue;
    }

    const joinOptions = join.options;
    const relationName = join.relation.name;
    const target = row[relationName];
    if (!target) {
      continue;
    }

    const patchTarget = (targetRow: Record<string, unknown>) => {
      const targetTable = join.relation.table;
      const externalId = getExternalIdFromRow(targetRow, targetTable);
      if (!externalId) {
        return;
      }

      if (overlay.store.hasTombstone(schemaName, targetTable.name, externalId)) {
        delete row[relationName];
        return;
      }

      const overlayRow = overlay.store.getRow(schemaName, targetTable.name, externalId);
      if (overlayRow) {
        const overlayOutput = buildOutputFromLofiRow(
          overlayRow,
          targetTable,
          joinOptions.select as undefined | true | readonly string[],
        );
        row[relationName] = mergeRowColumns(
          targetRow,
          overlayOutput,
          targetTable,
          joinOptions.select as undefined | true | readonly string[],
        );
      }

      patchJoinRows({
        row: row[relationName] as Record<string, unknown>,
        joins: joinOptions.join,
        overlay,
        schemaName,
      });
    };

    if (Array.isArray(target)) {
      for (const entry of target) {
        if (entry && typeof entry === "object") {
          patchTarget(entry as Record<string, unknown>);
        }
      }
      continue;
    }

    if (typeof target === "object") {
      patchTarget(target as Record<string, unknown>);
    }
  }
};

const stripSelection = (options: {
  row: Record<string, unknown>;
  table: AnyTable;
  select: undefined | true | readonly string[];
  joins: CompiledJoin[] | undefined;
}): Record<string, unknown> => {
  const { row, table, select, joins } = options;
  const stripped: Record<string, unknown> = { ...row };

  if (select && select !== true) {
    const keep = new Set(select);
    for (const key of Object.keys(stripped)) {
      if (table.columns[key] && !keep.has(key)) {
        delete stripped[key];
      }
    }
  }

  if (joins) {
    for (const join of joins) {
      if (join.options === false) {
        continue;
      }
      const joinOptions = join.options;
      const relationName = join.relation.name;
      const child = stripped[relationName];
      if (!child) {
        continue;
      }
      if (Array.isArray(child)) {
        stripped[relationName] = child.map((entry) =>
          stripSelection({
            row: entry as Record<string, unknown>,
            table: join.relation.table,
            select: joinOptions.select as undefined | true | readonly string[],
            joins: joinOptions.join,
          }),
        );
      } else if (typeof child === "object") {
        stripped[relationName] = stripSelection({
          row: child as Record<string, unknown>,
          table: join.relation.table,
          select: joinOptions.select as undefined | true | readonly string[],
          joins: joinOptions.join,
        });
      }
    }
  }

  return stripped;
};

const augmentSelect = (options: {
  table: AnyTable;
  select: undefined | true | readonly string[];
  orderColumns: AnyColumn[];
}): undefined | true | readonly string[] => {
  const { table, select, orderColumns } = options;
  if (!select || select === true) {
    return select;
  }

  const augmented = new Set(select);
  augmented.add(table.getIdColumn().name);
  for (const column of orderColumns) {
    augmented.add(column.name);
  }

  const result = Array.from(augmented);
  return result.length === select.length ? select : result;
};

const mergeRows = (options: {
  baseRows: Record<string, unknown>[];
  overlayRows: Record<string, unknown>[];
  overlay: InMemoryLofiAdapter;
  schemaName: string;
  table: AnyTable;
  select: undefined | true | readonly string[];
}): Record<string, unknown>[] => {
  const { baseRows, overlayRows, overlay, schemaName, table, select } = options;
  const baseIds = new Set<string>();
  const merged: Record<string, unknown>[] = [];

  const overlayOutputById = new Map<string, Record<string, unknown>>();

  for (const baseRow of baseRows) {
    const externalId = getExternalIdFromRow(baseRow, table);
    if (!externalId) {
      continue;
    }
    baseIds.add(externalId);

    if (overlay.store.hasTombstone(schemaName, table.name, externalId)) {
      continue;
    }

    const overlayRow = overlay.store.getRow(schemaName, table.name, externalId);
    if (overlayRow) {
      let overlayOutput = overlayOutputById.get(externalId);
      if (!overlayOutput) {
        overlayOutput = buildOutputFromLofiRow(overlayRow, table, select);
        overlayOutputById.set(externalId, overlayOutput);
      }
      merged.push(mergeRowColumns(baseRow, overlayOutput, table, select));
      continue;
    }

    merged.push(baseRow);
  }

  for (const overlayRow of overlayRows) {
    const externalId = getExternalIdFromRow(overlayRow, table);
    if (!externalId || baseIds.has(externalId)) {
      continue;
    }
    if (overlay.store.hasTombstone(schemaName, table.name, externalId)) {
      continue;
    }
    merged.push(overlayRow);
  }

  return merged;
};

export const createStackedQueryEngine = <T extends AnySchema>(options: {
  schema: T;
  base: LofiQueryableAdapter;
  overlay: InMemoryLofiAdapter;
  schemaName?: string;
}): LofiQueryInterface<T> => {
  const schemaName = options.schemaName ?? options.schema.name;
  const baseQuery = options.base.createQueryEngine(options.schema, { schemaName });
  const overlayQuery = options.overlay.createQueryEngine(options.schema, { schemaName });

  const runFind = async (
    tableName: string,
    builderFn: ((builder: FindBuilder<AnyTable>) => unknown) | undefined,
    withCursor: boolean,
  ): Promise<Record<string, unknown>[] | CursorResult<Record<string, unknown>> | number> => {
    const tableMap = options.schema.tables as Record<string, AnyTable>;
    const table = tableMap[tableName];
    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    const baseFind = baseQuery.find as unknown as (
      name: string,
      builder: (builder: FindBuilder<AnyTable>) => unknown,
    ) => Promise<Record<string, unknown>[] | number>;
    const baseFindWithCursor = baseQuery.findWithCursor as unknown as (
      name: string,
      builder: (builder: FindBuilder<AnyTable>) => unknown,
    ) => Promise<CursorResult<Record<string, unknown>>>;
    const overlayFind = overlayQuery.find as unknown as (
      name: string,
      builder: (builder: FindBuilder<AnyTable>) => unknown,
    ) => Promise<Record<string, unknown>[] | number>;

    const builder = buildFindBuilder(tableName, table);
    if (builderFn) {
      builderFn(builder);
    } else {
      builder.whereIndex("primary");
    }

    const built = builder.build() as
      | { type: "find"; indexName: string; options: BuiltFindOptions }
      | { type: "count"; indexName: string; options: Pick<BuiltFindOptions, "where"> };

    if (built.type === "count") {
      const countBuilder = (b: FindBuilder<AnyTable>) => {
        if (!built.options.where) {
          b.whereIndex(built.indexName as "primary");
          return;
        }
        if (typeof built.options.where === "function") {
          b.whereIndex(built.indexName as "primary", built.options.where as () => Condition);
          return;
        }
        b.whereIndex(built.indexName as "primary", () => built.options.where as Condition);
      };

      const baseRows = (await baseFind(tableName, countBuilder)) as Record<string, unknown>[];
      const overlayRows = (await overlayFind(tableName, countBuilder)) as Record<string, unknown>[];

      const merged = mergeRows({
        baseRows,
        overlayRows,
        overlay: options.overlay,
        schemaName,
        table,
        select: undefined,
      });

      return merged.length;
    }

    const orderIndexName = built.options.orderByIndex?.indexName ?? built.indexName;
    const direction = built.options.orderByIndex?.direction ?? "asc";
    const orderColumns = buildOrderColumns(table, orderIndexName);
    const originalSelect = built.options.select as undefined | true | readonly string[];
    const select = augmentSelect({
      table,
      select: originalSelect,
      orderColumns,
    });

    const overlayPageSize = built.options.pageSize;
    const overlayBuilder = (b: FindBuilder<AnyTable>) => {
      if (builderFn) {
        builderFn(b);
      } else {
        b.whereIndex("primary");
      }
      if (select && select !== originalSelect) {
        b.select(select as unknown as true | string[]);
      }
      if (overlayPageSize !== undefined) {
        b.pageSize(overlayPageSize);
      }
    };

    const overlayRows = (await overlayFind(tableName, overlayBuilder)) as Record<string, unknown>[];

    const baseRows: Record<string, unknown>[] = [];
    let mergedRows: Record<string, unknown>[] = [];
    let hasNextBase = false;
    let cursor: Cursor | undefined;

    const pageSize = built.options.pageSize;
    if (pageSize === undefined) {
      const baseBuilder = (b: FindBuilder<AnyTable>) => {
        if (builderFn) {
          builderFn(b);
        } else {
          b.whereIndex("primary");
        }
        if (select && select !== originalSelect) {
          b.select(select as unknown as true | string[]);
        }
      };

      baseRows.push(...((await baseFind(tableName, baseBuilder)) as Record<string, unknown>[]));
    } else {
      let nextAfter: Cursor | string | undefined = built.options.after;
      let nextBefore: Cursor | string | undefined = built.options.before;
      let firstPage = true;
      let keepFetching = true;

      while (keepFetching) {
        const baseBuilder = (b: FindBuilder<AnyTable>) => {
          if (builderFn) {
            builderFn(b);
          } else {
            b.whereIndex("primary");
          }
          if (select && select !== originalSelect) {
            b.select(select as unknown as true | string[]);
          }
          b.pageSize(pageSize);
          if (firstPage) {
            if (nextAfter) {
              b.after(nextAfter);
            }
            if (nextBefore) {
              b.before(nextBefore);
            }
          } else if (cursor) {
            b.after(cursor);
          }
        };

        const page = (await baseFindWithCursor(tableName, baseBuilder)) as CursorResult<
          Record<string, unknown>
        >;

        baseRows.push(...page.items);
        hasNextBase = page.hasNextPage;
        cursor = page.cursor;
        nextAfter = undefined;
        nextBefore = undefined;
        firstPage = false;

        mergedRows = mergeRows({
          baseRows,
          overlayRows,
          overlay: options.overlay,
          schemaName,
          table,
          select,
        });

        mergedRows = mergedRows.sort((left, right) =>
          compareRows(left, right, orderColumns, direction),
        );
        mergedRows = applyCursorFilters({
          rows: mergedRows,
          orderColumns,
          direction,
          after: built.options.after,
          before: built.options.before,
        });

        if (!pageSize || mergedRows.length > pageSize || !hasNextBase) {
          break;
        }
      }
    }

    if (pageSize === undefined || baseRows.length > 0) {
      mergedRows = mergeRows({
        baseRows,
        overlayRows,
        overlay: options.overlay,
        schemaName,
        table,
        select,
      });
    }

    mergedRows = mergedRows.sort((left, right) =>
      compareRows(left, right, orderColumns, direction),
    );
    mergedRows = applyCursorFilters({
      rows: mergedRows,
      orderColumns,
      direction,
      after: built.options.after,
      before: built.options.before,
    });

    for (const row of mergedRows) {
      patchJoinRows({
        row,
        joins: built.options.joins,
        overlay: options.overlay,
        schemaName,
      });
    }

    if (!withCursor) {
      const limited =
        pageSize !== undefined ? mergedRows.slice(0, Math.max(0, pageSize)) : mergedRows;
      return limited.map((row) =>
        stripSelection({
          row,
          table,
          select: originalSelect,
          joins: built.options.joins,
        }),
      );
    }

    let hasNextPage = false;
    let items = mergedRows;

    if (pageSize && mergedRows.length > pageSize) {
      hasNextPage = true;
      items = mergedRows.slice(0, pageSize);
    }

    let nextCursor: Cursor | undefined;
    const lastRow = items[items.length - 1];
    if (lastRow && pageSize) {
      nextCursor = createCursorFromRecord(lastRow, orderColumns, {
        indexName: orderIndexName,
        orderDirection: direction,
        pageSize,
      });
    }

    return {
      items: items.map((row) =>
        stripSelection({
          row,
          table,
          select: originalSelect,
          joins: built.options.joins,
        }),
      ),
      cursor: nextCursor,
      hasNextPage,
    };
  };

  return {
    async find(tableName, builderFn) {
      const result = await runFind(
        tableName,
        builderFn as unknown as (builder: FindBuilder<AnyTable>) => unknown,
        false,
      );
      return result as Record<string, unknown>[] | number;
    },

    async findWithCursor(tableName, builderFn) {
      const result = await runFind(
        tableName,
        builderFn as unknown as (builder: FindBuilder<AnyTable>) => unknown,
        true,
      );
      return result as CursorResult<Record<string, unknown>>;
    },

    async findFirst(tableName, builderFn) {
      const result = await runFind(
        tableName,
        builderFn
          ? (builder: FindBuilder<AnyTable>) => {
              (builderFn as unknown as (b: FindBuilder<AnyTable>) => unknown)(builder);
              builder.pageSize(1);
              return builder;
            }
          : (builder: FindBuilder<AnyTable>) => builder.whereIndex("primary").pageSize(1),
        false,
      );

      if (typeof result === "number") {
        return null;
      }

      return (result as Record<string, unknown>[])[0] ?? null;
    },
  } as LofiQueryInterface<T>;
};
