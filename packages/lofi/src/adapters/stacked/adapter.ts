import type { AnySchema, AnyTable } from "@fragno-dev/db/schema";
import type {
  LofiAdapter,
  LofiMutation,
  LofiQueryEngineOptions,
  LofiQueryInterface,
  LofiQueryableAdapter,
} from "../../types";
import { InMemoryLofiAdapter } from "../in-memory/adapter";
import { createStackedQueryEngine } from "./merge";

export type StackedLofiAdapterOptions = {
  base: LofiAdapter & LofiQueryableAdapter;
  overlay: InMemoryLofiAdapter;
  schemas: AnySchema[];
};

const extractRowValues = (
  row: Record<string, unknown>,
  table: AnyTable,
): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  for (const columnName of Object.keys(table.columns)) {
    if (columnName in row) {
      values[columnName] = row[columnName];
    }
  }
  return values;
};

export class StackedLofiAdapter implements LofiAdapter, LofiQueryableAdapter {
  private readonly base: LofiAdapter & LofiQueryableAdapter;
  private readonly overlay: InMemoryLofiAdapter;
  private readonly schemaMap: Map<string, AnySchema>;

  constructor(options: StackedLofiAdapterOptions) {
    const schemaMap = new Map<string, AnySchema>();
    for (const schema of options.schemas) {
      if (!schema.name || schema.name.trim().length === 0) {
        throw new Error("StackedLofiAdapter schemas must have a non-empty name.");
      }
      if (schemaMap.has(schema.name)) {
        throw new Error(`StackedLofiAdapter schema name must be unique: ${schema.name}`);
      }
      schemaMap.set(schema.name, schema);
    }

    this.base = options.base;
    this.overlay = options.overlay;
    this.schemaMap = schemaMap;
  }

  async applyOutboxEntry(options: {
    sourceKey: string;
    versionstamp: string;
    uowId: string;
    mutations: LofiMutation[];
  }): Promise<{ applied: boolean }> {
    return this.base.applyOutboxEntry(options);
  }

  async applyMutations(mutations: LofiMutation[]): Promise<void> {
    if (!this.base || !this.overlay) {
      return;
    }

    const materialized: LofiMutation[] = [];

    for (const mutation of mutations) {
      if (mutation.op !== "update") {
        materialized.push(mutation);
        continue;
      }

      const schema = this.schemaMap.get(mutation.schema);
      if (!schema) {
        throw new Error(`Unknown mutation schema: ${mutation.schema}`);
      }
      const table = schema.tables[mutation.table];
      if (!table) {
        throw new Error(`Unknown mutation table: ${mutation.schema}.${mutation.table}`);
      }

      const baseQuery = this.base.createQueryEngine(schema);
      const baseRow = (await baseQuery.findFirst(mutation.table, (b) =>
        b.whereIndex("primary", (eb) =>
          (eb as unknown as (col: string, op: "=", value: string) => boolean)(
            table.getIdColumn().name,
            "=",
            mutation.externalId,
          ),
        ),
      )) as Record<string, unknown> | null;

      let values: Record<string, unknown> | null = null;

      if (baseRow) {
        values = { ...extractRowValues(baseRow, table) };
      } else {
        const overlayRow = this.overlay.store.getRow(
          mutation.schema,
          mutation.table,
          mutation.externalId,
        );
        if (overlayRow) {
          values = { ...overlayRow.data };
        }
      }

      if (!values) {
        materialized.push(mutation);
        continue;
      }

      materialized.push({
        op: "create",
        schema: mutation.schema,
        table: mutation.table,
        externalId: mutation.externalId,
        values: { ...values, ...mutation.set },
        versionstamp: mutation.versionstamp,
      });
    }

    if (materialized.length > 0) {
      await this.overlay.applyMutations(materialized);
    }
  }

  async getMeta(key: string): Promise<string | undefined> {
    return this.base.getMeta(key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.base.setMeta(key, value);
  }

  createQueryEngine<const T extends AnySchema>(
    schema: T,
    options?: LofiQueryEngineOptions,
  ): LofiQueryInterface<T> {
    return createStackedQueryEngine({
      schema,
      base: this.base,
      overlay: this.overlay,
      schemaName: options?.schemaName,
    });
  }
}
