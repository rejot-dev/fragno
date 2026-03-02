import { parseVarchar } from "../util/parse";
import type { AnyColumn, AnySchema, AnyTable, Relation } from "../schema/create";
import {
  defaultNamingStrategyForDatabase,
  type SupportedDatabase,
} from "../adapters/generic-sql/driver-config";
import type { SQLiteStorageMode } from "../adapters/generic-sql/sqlite-storage";
import { sqliteStorageDefault, sqliteStoragePrisma } from "../adapters/generic-sql/sqlite-storage";
import {
  sanitizeNamespace,
  createNamingResolver,
  type NamingResolver,
  type SqlNamingStrategy,
} from "../naming/sql-naming";
import { internalSchema } from "../fragments/internal-fragment.schema";

export interface GeneratePrismaSchemaOptions {
  sqliteStorageMode?: SQLiteStorageMode;
  namingStrategy?: SqlNamingStrategy;
}

const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isValidIdentifier(name: string): boolean {
  return VALID_IDENTIFIER.test(name);
}

function sanitizeIdentifier(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (sanitized.length === 0) {
    return "_";
  }
  if (/^[0-9]/.test(sanitized)) {
    return `_${sanitized}`;
  }
  return sanitized;
}

function ensureUniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    return base;
  }
  let index = 1;
  let candidate = `${base}_${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${base}_${index}`;
  }
  return candidate;
}

function toPascalCase(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
}

function isVarcharType(value: string): value is `varchar(${number})` {
  return value.startsWith("varchar(");
}

function getModelName(table: AnyTable, namespace: string | null): string {
  const base = toPascalCase(table.name);
  if (!namespace) {
    return base;
  }
  return `${base}_${sanitizeNamespace(namespace)}`;
}

function getPhysicalTableName(table: AnyTable, resolver?: NamingResolver): string {
  return resolver ? resolver.getTableName(table.name) : table.name;
}

function getRelationName(
  namespace: string | null,
  from: string,
  referenceName: string,
  to: string,
): string {
  if (!namespace) {
    return `${from}_${referenceName}_${to}`;
  }
  return `${namespace}_${from}_${referenceName}_${to}`;
}

function getForeignKeyMapName(
  table: AnyTable,
  relation: Relation,
  _namespace: string | null,
  resolver?: NamingResolver,
): string {
  if (resolver) {
    return resolver.getForeignKeyName({
      logicalTable: table.name,
      logicalReferencedTable: relation.table.name,
      referenceName: relation.name,
    });
  }
  return `${table.name}_${relation.table.name}_${relation.name}_fk`;
}

function getIndexMapName(
  indexName: string,
  tableName: string,
  namespace: string | null,
  resolver?: NamingResolver,
  unique?: boolean,
): string {
  if (!resolver) {
    return namespace ? `${indexName}_${namespace}` : indexName;
  }
  return unique
    ? resolver.getUniqueIndexName(indexName, tableName)
    : resolver.getIndexName(indexName, tableName);
}

function getPrismaScalarType(
  column: AnyColumn,
  provider: SupportedDatabase,
  sqliteStorageMode: SQLiteStorageMode,
): { type: string; nativeType?: string } {
  const internalIdType = provider === "sqlite" ? "Int" : "BigInt";

  if (column.role === "internal-id") {
    return { type: internalIdType };
  }

  if (column.role === "reference") {
    return { type: internalIdType };
  }

  if (isVarcharType(column.type)) {
    const length = parseVarchar(column.type);
    if (provider === "postgresql" || provider === "mysql") {
      return { type: "String", nativeType: `@db.VarChar(${length})` };
    }
    return { type: "String" };
  }

  switch (column.type) {
    case "string":
      return { type: "String" };
    case "integer":
      return { type: "Int" };
    case "bigint":
      if (provider === "sqlite" && sqliteStorageMode.bigintStorage === "blob") {
        return { type: "Bytes" };
      }
      return { type: "BigInt" };
    case "bool":
      return { type: "Boolean" };
    case "decimal":
      if (provider === "sqlite") {
        return { type: "Float" };
      }
      return { type: "Decimal" };
    case "binary":
      return { type: "Bytes" };
    case "json":
      if (provider === "postgresql") {
        return { type: "Json", nativeType: "@db.Json" };
      }
      return { type: "Json" };
    case "timestamp":
      if (provider === "sqlite" && sqliteStorageMode.timestampStorage === "epoch-ms") {
        return { type: "Int" };
      }
      return { type: "DateTime" };
    case "date":
      if (provider === "sqlite" && sqliteStorageMode.dateStorage === "epoch-ms") {
        return { type: "Int" };
      }
      if (provider === "postgresql" || provider === "mysql") {
        return { type: "DateTime", nativeType: "@db.Date" };
      }
      return { type: "DateTime" };
    default: {
      const exhaustiveCheck: never = column.type;
      throw new Error(`Unsupported column type: ${exhaustiveCheck}`);
    }
  }
}

function formatDefaultValue(value: unknown): string {
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return JSON.stringify(value);
}

function getColumnDefault(
  column: AnyColumn,
  provider: SupportedDatabase,
  sqliteStorageMode: SQLiteStorageMode,
): string | undefined {
  if (!column.default) {
    return undefined;
  }

  if ("value" in column.default) {
    return `@default(${formatDefaultValue(column.default.value)})`;
  }

  if ("dbSpecial" in column.default && column.default.dbSpecial === "now") {
    const scalar = getPrismaScalarType(column, provider, sqliteStorageMode);
    if (scalar.type === "DateTime") {
      return "@default(now())";
    }
    if (provider === "sqlite") {
      const storage =
        column.type === "date" ? sqliteStorageMode.dateStorage : sqliteStorageMode.timestampStorage;
      if (storage === "epoch-ms") {
        return `@default(dbgenerated("CURRENT_TIMESTAMP"))`;
      }
    }
  }

  return undefined;
}

function getColumnFieldName(
  columnName: string,
  usedNames: Set<string>,
): { fieldName: string; needsMap: boolean } {
  const isValid = isValidIdentifier(columnName);
  const baseName = isValid ? columnName : sanitizeIdentifier(columnName);
  const fieldName = ensureUniqueName(baseName, usedNames);
  return { fieldName, needsMap: fieldName !== columnName };
}

function getRelationFieldName(baseName: string, usedNames: Set<string>): string {
  const validBase = isValidIdentifier(baseName) ? baseName : sanitizeIdentifier(baseName);
  return ensureUniqueName(validBase, usedNames);
}

function isRelationOptional(relation: Relation, columnFieldNames: Map<string, AnyColumn>): boolean {
  for (const [localColumn] of relation.on) {
    const column = columnFieldNames.get(localColumn);
    if (column?.isNullable) {
      return true;
    }
  }
  return false;
}

function getColumnFieldMappings(table: AnyTable): {
  fieldNameByColumn: Map<string, string>;
  columnByName: Map<string, AnyColumn>;
} {
  const fieldNameByColumn = new Map<string, string>();
  const columnByName = new Map<string, AnyColumn>();
  const usedNames = new Set<string>();

  for (const column of Object.values(table.columns)) {
    const { fieldName } = getColumnFieldName(column.name, usedNames);
    usedNames.add(fieldName);
    fieldNameByColumn.set(column.name, fieldName);
    columnByName.set(column.name, column);
  }

  return { fieldNameByColumn, columnByName };
}

function areInverseRelations(one: Relation, many: Relation): boolean {
  if (one.type !== "one" || many.type !== "many") {
    return false;
  }
  if (one.foreignKey === false || many.foreignKey === false) {
    return false;
  }
  if (one.referencer !== many.table || one.table !== many.referencer) {
    return false;
  }
  return one.on.every(([left, right]) =>
    many.on.some(([manyLeft, manyRight]) => manyLeft === right && manyRight === left),
  );
}

function findMatchingManyRelation(one: Relation): Relation | undefined {
  for (const relation of Object.values(one.table.relations)) {
    if (relation.type !== "many") {
      continue;
    }
    if (relation.foreignKey === false) {
      continue;
    }
    if (areInverseRelations(one, relation)) {
      return relation;
    }
  }
  return undefined;
}

function findMatchingOneRelation(many: Relation): Relation | undefined {
  for (const relation of Object.values(many.table.relations)) {
    if (relation.type !== "one") {
      continue;
    }
    if (relation.foreignKey === false) {
      continue;
    }
    if (areInverseRelations(relation, many)) {
      return relation;
    }
  }
  return undefined;
}

function generateColumnFields(
  table: AnyTable,
  provider: SupportedDatabase,
  sqliteStorageMode: SQLiteStorageMode,
  fieldNameByColumn: Map<string, string>,
  resolver?: NamingResolver,
): string[] {
  const lines: string[] = [];

  for (const column of Object.values(table.columns)) {
    const fieldName = fieldNameByColumn.get(column.name)!;
    const scalar = getPrismaScalarType(column, provider, sqliteStorageMode);
    const isOptional = column.isNullable;

    const attributes: string[] = [];

    if (column.role === "internal-id") {
      attributes.push("@id", "@default(autoincrement())");
    }

    if (column.role === "external-id") {
      attributes.push("@unique", "@default(cuid())");
    }

    const defaultValue = getColumnDefault(column, provider, sqliteStorageMode);
    if (defaultValue) {
      attributes.push(defaultValue);
    }

    if (scalar.nativeType) {
      attributes.push(scalar.nativeType);
    }

    const physicalName = resolver ? resolver.getColumnName(table.name, column.name) : column.name;
    if (fieldName !== physicalName) {
      attributes.push(`@map("${physicalName}")`);
    }

    const suffix = isOptional ? "?" : "";
    const attrSuffix = attributes.length > 0 ? ` ${attributes.join(" ")}` : "";
    lines.push(`  ${fieldName} ${scalar.type}${suffix}${attrSuffix}`);
  }

  return lines;
}

function generateRelationFields(
  table: AnyTable,
  namespace: string | null,
  fieldNameByColumn: Map<string, string>,
  columnByName: Map<string, AnyColumn>,
  fieldNameByTableColumn: Map<AnyTable, Map<string, string>>,
  resolver?: NamingResolver,
): string[] {
  const lines: string[] = [];
  const usedNames = new Set<string>(fieldNameByColumn.values());
  const relations = Object.values(table.relations)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const relation of relations) {
    if (relation.type !== "one") {
      continue;
    }
    if (relation.foreignKey === false) {
      continue;
    }

    const fieldName = getRelationFieldName(relation.name, usedNames);
    usedNames.add(fieldName);

    const relationName = getRelationName(namespace, table.name, relation.name, relation.table.name);

    const relatedModel = getModelName(relation.table, namespace);
    const localFields = relation.on.map(([left]) => fieldNameByColumn.get(left) ?? left);
    const referenceFields = relation.on.map(([, right]) => {
      const actualRight = right === "id" ? "_internalId" : right;
      const refFieldNames = fieldNameByTableColumn.get(relation.table);
      return refFieldNames?.get(actualRight) ?? actualRight;
    });

    const fkMapName = getForeignKeyMapName(table, relation, namespace, resolver);

    const relationParts = [
      `"${relationName}"`,
      `fields: [${localFields.join(", ")}]`,
      `references: [${referenceFields.join(", ")}]`,
      `map: "${fkMapName}"`,
    ];

    const optional = isRelationOptional(relation, columnByName);
    const suffix = optional ? "?" : "";

    lines.push(`  ${fieldName} ${relatedModel}${suffix} @relation(${relationParts.join(", ")})`);
  }

  for (const relation of relations) {
    if (relation.type !== "many") {
      continue;
    }
    if (relation.foreignKey === false) {
      continue;
    }

    const matchingOne = findMatchingOneRelation(relation);
    const relationName = matchingOne
      ? getRelationName(
          namespace,
          matchingOne.referencer.name,
          matchingOne.name,
          matchingOne.table.name,
        )
      : getRelationName(namespace, relation.referencer.name, relation.name, relation.table.name);

    const fieldName = getRelationFieldName(relation.name, usedNames);
    usedNames.add(fieldName);

    const relatedModel = getModelName(relation.table, namespace);
    lines.push(`  ${fieldName} ${relatedModel}[] @relation("${relationName}")`);
  }

  const inverseCandidates: Relation[] = [];
  for (const sourceTable of fieldNameByTableColumn.keys()) {
    for (const rel of Object.values(sourceTable.relations)) {
      if (rel.type === "one" && rel.table === table && rel.foreignKey !== false) {
        inverseCandidates.push(rel);
      }
    }
  }

  for (const rel of inverseCandidates.sort((a, b) => a.name.localeCompare(b.name))) {
    const matchingMany = findMatchingManyRelation(rel);
    if (matchingMany) {
      continue;
    }

    const baseName = rel.referencer.name;
    let fieldName = baseName;
    if (usedNames.has(fieldName)) {
      fieldName = `${baseName}_${rel.name}`;
    }
    fieldName = getRelationFieldName(fieldName, usedNames);
    usedNames.add(fieldName);

    const relationName = getRelationName(namespace, rel.referencer.name, rel.name, rel.table.name);

    const relatedModel = getModelName(rel.referencer, namespace);
    lines.push(`  ${fieldName} ${relatedModel}[] @relation("${relationName}")`);
  }

  return lines;
}

function generateModel(
  table: AnyTable,
  namespace: string | null,
  provider: SupportedDatabase,
  sqliteStorageMode: SQLiteStorageMode,
  fieldNameByTableColumn: Map<AnyTable, Map<string, string>>,
  columnByTableName: Map<AnyTable, Map<string, AnyColumn>>,
  resolver?: NamingResolver,
): string {
  const modelName = getModelName(table, namespace);
  const physicalName = getPhysicalTableName(table, resolver);

  const fieldNameByColumn = fieldNameByTableColumn.get(table)!;
  const columnByName = columnByTableName.get(table)!;

  const fieldLines = [
    ...generateColumnFields(table, provider, sqliteStorageMode, fieldNameByColumn, resolver),
    ...generateRelationFields(
      table,
      namespace,
      fieldNameByColumn,
      columnByName,
      fieldNameByTableColumn,
      resolver,
    ),
  ];

  const indexLines: string[] = [];
  const sortedIndexes = Object.values(table.indexes)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const index of sortedIndexes) {
    const fields = index.columnNames
      .map((name) => fieldNameByColumn.get(name as string) ?? name)
      .join(", ");
    const mapName = getIndexMapName(index.name, table.name, namespace, resolver, index.unique);
    const directive = index.unique ? "@@unique" : "@@index";
    indexLines.push(`  ${directive}([${fields}], map: "${mapName}")`);
  }

  indexLines.push(`  @@map("${physicalName}")`);

  const lines = [`model ${modelName} {`, ...fieldLines, ...indexLines, `}`];
  return lines.join("\n");
}

export function generatePrismaSchema(
  fragments: { namespace: string | null; schema: AnySchema }[],
  provider: SupportedDatabase,
  options?: GeneratePrismaSchemaOptions,
): string {
  const sqliteStorageMode =
    options?.sqliteStorageMode ??
    (provider === "sqlite" ? sqliteStoragePrisma : sqliteStorageDefault);
  const namingStrategy = options?.namingStrategy ?? defaultNamingStrategyForDatabase(provider);
  const sortedFragments = [...fragments].sort((a, b) => {
    const aInternal = a.schema === internalSchema;
    const bInternal = b.schema === internalSchema;
    if (aInternal) {
      return -1;
    }
    if (bInternal) {
      return 1;
    }
    return a.schema.name.localeCompare(b.schema.name);
  });

  const namespaces: Array<string | null> = [];
  const seenNamespaces = new Set<string | null>();
  for (const fragment of sortedFragments) {
    if (!seenNamespaces.has(fragment.namespace)) {
      seenNamespaces.add(fragment.namespace);
      namespaces.push(fragment.namespace);
    }
  }

  const fieldNameByTableColumn = new Map<AnyTable, Map<string, string>>();
  const columnByTableName = new Map<AnyTable, Map<string, AnyColumn>>();

  for (const fragment of sortedFragments) {
    for (const table of Object.values(fragment.schema.tables)) {
      const mapping = getColumnFieldMappings(table);
      fieldNameByTableColumn.set(table, mapping.fieldNameByColumn);
      columnByTableName.set(table, mapping.columnByName);
    }
  }

  const headerNamespaces = namespaces.filter(Boolean);
  const headerSuffix = headerNamespaces.length > 0 ? headerNamespaces.join(", ") : "(internal)";
  const lines: string[] = [
    "// Generated by Fragno Prisma adapter.",
    `// Provider: ${provider}`,
    `// Namespaces: ${headerSuffix}`,
    "",
  ];

  const models: string[] = [];

  for (const fragment of sortedFragments) {
    const resolver = createNamingResolver(fragment.schema, fragment.namespace, namingStrategy);
    const tables = Object.values(fragment.schema.tables)
      .slice()
      .sort((a, b) => {
        const aName = getPhysicalTableName(a, resolver);
        const bName = getPhysicalTableName(b, resolver);
        return aName.localeCompare(bName);
      });

    for (const table of tables) {
      models.push(
        generateModel(
          table,
          fragment.namespace,
          provider,
          sqliteStorageMode,
          fieldNameByTableColumn,
          columnByTableName,
          resolver,
        ),
      );
    }
  }

  lines.push(models.join("\n\n"));
  return lines.join("\n");
}
