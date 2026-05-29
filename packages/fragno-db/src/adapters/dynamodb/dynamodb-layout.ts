import { createHash } from "node:crypto";

import {
  createNamingResolver,
  suffixNamingStrategy,
  type NamingResolver,
  type SqlNamingStrategy,
} from "../../naming/sql-naming";
import type { AnySchema, AnyTable } from "../../schema/create";

const MAX_TABLE_NAME_LENGTH = 255;
const HASH_LENGTH = 10;

export interface DynamoDBTableLayout {
  logicalTableName: string;
  baseTableName: string;
  indexTableName: string;
}

export interface DynamoDBLayout {
  tablePrefix: string;
  namespace: string;
  settingsTableName: string;
  resolver: NamingResolver;
  getTableLayout(table: AnyTable | string): DynamoDBTableLayout;
  getAllTableLayouts(): DynamoDBTableLayout[];
}

export interface DynamoDBLayoutOptions {
  schema: AnySchema;
  namespace: string | null;
  tablePrefix?: string;
  namingStrategy?: SqlNamingStrategy;
}

const hash = (value: string) =>
  createHash("sha1").update(value).digest("hex").slice(0, HASH_LENGTH);

export function escapeDynamoDBTableNameComponent(value: string): string {
  if (value.length === 0) {
    return "empty";
  }

  let output = "";
  for (const char of value) {
    if (/^[A-Za-z0-9_.-]$/.test(char)) {
      output += char;
      continue;
    }
    output += `_u${char.codePointAt(0)!.toString(16).padStart(4, "0")}_`;
  }
  return output;
}

export function joinDynamoDBTableName(components: readonly string[]): string {
  const name = components.map(escapeDynamoDBTableNameComponent).join("__");
  if (name.length <= MAX_TABLE_NAME_LENGTH) {
    return name;
  }
  return `${name.slice(0, MAX_TABLE_NAME_LENGTH - HASH_LENGTH - 2)}__${hash(name)}`;
}

export function createDynamoDBLayout({
  schema,
  namespace,
  tablePrefix = "fragno",
  namingStrategy = suffixNamingStrategy,
}: DynamoDBLayoutOptions): DynamoDBLayout {
  const effectiveNamespace = namespace ?? schema.name;
  const resolver = createNamingResolver(schema, null, namingStrategy);
  const settingsTableName = joinDynamoDBTableName([tablePrefix, "settings"]);

  const getTableLayout = (table: AnyTable | string): DynamoDBTableLayout => {
    const logicalTableName = typeof table === "string" ? table : table.name;
    const physicalTableName = resolver.getTableName(logicalTableName);
    const baseTableName = joinDynamoDBTableName([
      tablePrefix,
      effectiveNamespace,
      physicalTableName,
    ]);
    return {
      logicalTableName,
      baseTableName,
      indexTableName: joinDynamoDBTableName([baseTableName, "idx"]),
    };
  };

  return {
    tablePrefix,
    namespace: effectiveNamespace,
    settingsTableName,
    resolver,
    getTableLayout,
    getAllTableLayouts: () => Object.values(schema.tables).map(getTableLayout),
  };
}
