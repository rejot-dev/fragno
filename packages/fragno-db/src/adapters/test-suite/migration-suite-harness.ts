import type { AnySchema } from "../../schema/create";
import type { DatabaseAdapter } from "../adapters";

export interface MigrationSuiteHarness {
  name: string;
  createAdapter: () => Promise<{
    // oxlint-disable-next-line no-explicit-any
    adapter: DatabaseAdapter<any>;
    close?: () => Promise<void> | void;
  }>;
  inspector: MigrationInspector;
  capabilities?: {
    foreignKeys?: boolean;
  };
}

export interface MigrationInspector {
  inspectSchema(args: {
    // oxlint-disable-next-line no-explicit-any
    adapter: DatabaseAdapter<any>;
    schema: AnySchema;
    namespace: string | null;
  }): Promise<ObservedSchema>;
  bootstrapLegacyV1(args: {
    // oxlint-disable-next-line no-explicit-any
    adapter: DatabaseAdapter<any>;
    schema: AnySchema;
    namespace: string | null;
  }): Promise<void>;
}

export interface ObservedSchema {
  tables: Record<string, ObservedTable>;
  settings: Record<string, string | undefined>;
}

export interface ObservedTable {
  exists: boolean;
  columns: Record<string, ObservedColumn>;
  indexes: Record<string, ObservedIndex>;
  foreignKeys: ObservedForeignKey[];
}

export interface ObservedColumn {
  exists: boolean;
  nullable?: boolean;
  logicalType?: "string" | "integer" | "bigint" | "boolean" | "timestamp" | "json" | "text";
  defaultKind?: "none" | "zero" | "now" | "global-shard" | "database-specific";
}

export interface ObservedIndex {
  exists: boolean;
  unique?: boolean;
  columns?: string[];
}

export interface ObservedForeignKey {
  columns: string[];
  referencesTable: string;
  referencesColumns: string[];
}
