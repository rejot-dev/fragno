import { importGenerator } from "../util/import-generator";
import { ident, parseVarchar } from "../util/parse";
import {
  type AnyColumn,
  type AnySchema,
  type AnyTable,
  type Relation,
  InternalIdColumn,
} from "../schema/create";
import {
  createNamingResolver,
  sanitizeNamespace,
  type NamingResolver,
  type SqlNamingStrategy,
} from "../naming/sql-naming";
import { internalSchema } from "../fragments/internal-fragment";
import { type DatabaseTypeLiteral } from "../schema/type-conversion/type-mapping";
import { createSQLTypeMapper } from "../schema/type-conversion/create-sql-type-mapper";
import {
  defaultNamingStrategyForDatabase,
  type SupportedDatabase,
} from "../adapters/generic-sql/driver-config";

// ============================================================================
// PROVIDER CONFIGURATION
// ============================================================================

const PROVIDER_IMPORTS = {
  mysql: "drizzle-orm/mysql-core",
  postgresql: "drizzle-orm/pg-core",
  sqlite: "drizzle-orm/sqlite-core",
} as const;

const PROVIDER_TABLE_FUNCTIONS = {
  mysql: "mysqlTable",
  postgresql: "pgTable",
  sqlite: "sqliteTable",
} as const;

export type SupportedProvider = SupportedDatabase;

// ============================================================================
// CONTEXT
// ============================================================================

interface GeneratorContext {
  provider: SupportedProvider;
  imports: ReturnType<typeof importGenerator>;
  importSource: string;
  generatedCustomTypes: Set<string>;
  idGeneratorImport?: { name: string; from: string };
}

function createContext(
  provider: SupportedDatabase,
  idGeneratorImport?: { name: string; from: string },
): GeneratorContext {
  return {
    provider,
    imports: importGenerator(),
    importSource: PROVIDER_IMPORTS[provider],
    generatedCustomTypes: new Set<string>(),
    idGeneratorImport,
  };
}

// ============================================================================
// CUSTOM TYPE GENERATION
// ============================================================================

interface CustomTypeOptions {
  dataType: string;
  driverDataType: string;
  databaseDataType: string;
  fromDriverCode: string;
  toDriverCode: string;
}

function generateCustomType(
  ctx: GeneratorContext,
  name: string,
  options: CustomTypeOptions,
): string | undefined {
  if (ctx.generatedCustomTypes.has(name)) {
    return undefined;
  }

  ctx.imports.addImport("customType", ctx.importSource);
  ctx.generatedCustomTypes.add(name);

  return `const ${name} = customType<
  {
    data: ${options.dataType};
    driverData: ${options.driverDataType};
  }
>({
  dataType() {
    return "${options.databaseDataType}";
  },
  fromDriver(value) {
    ${options.fromDriverCode}
  },
  toDriver(value) {
    ${options.toDriverCode}
  }
});`;
}

function generateBinaryCustomType(ctx: GeneratorContext, customTypes: string[]): string {
  const name = "customBinary";
  const typeMapper = createSQLTypeMapper(ctx.provider);
  const code = generateCustomType(ctx, name, {
    dataType: "Uint8Array",
    driverDataType: "Buffer",
    databaseDataType: typeMapper.getDatabaseType({ type: "binary" }),
    fromDriverCode: "return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)",
    toDriverCode: `return value instanceof Buffer? value : Buffer.from(value)`,
  });

  if (code) {
    customTypes.push(code);
  }
  return name;
}

// ============================================================================
// COLUMN TYPE MAPPING
// ============================================================================

interface ColumnTypeFunction {
  name: string;
  isCustomType?: boolean;
  params?: string[];
}

/**
 * Maps SQL database types to Drizzle function names and parameters.
 * Uses SQLTypeMapper as the source of truth for type conversion.
 */
function getColumnTypeFunction(
  ctx: GeneratorContext,
  column: AnyColumn,
  customTypes: string[],
): ColumnTypeFunction {
  // Get the canonical database type from type mapper
  const typeMapper = createSQLTypeMapper(ctx.provider);
  const dbType = typeMapper.getDatabaseType(column);

  // Map database types to Drizzle function names
  return mapDBTypeToDrizzleFunction(ctx, dbType, column, customTypes);
}

/**
 * Maps a database type string to a Drizzle function name and parameters.
 */
function mapDBTypeToDrizzleFunction(
  ctx: GeneratorContext,
  dbType: DatabaseTypeLiteral,
  column: AnyColumn,
  customTypes: string[],
): ColumnTypeFunction {
  // Handle provider-specific types
  if (ctx.provider === "postgresql") {
    switch (dbType) {
      case "bigserial":
        // bigserial requires a mode parameter in Drizzle
        return { name: "bigserial", params: [`{ mode: "number" }`] };
      case "serial":
        return { name: "serial" };
      case "boolean":
        return { name: "boolean" };
      case "bytea":
        return { name: generateBinaryCustomType(ctx, customTypes), isCustomType: true };
      case "json":
        return { name: "json" };
      case "text":
        return { name: "text" };
      case "bigint":
        return { name: "bigint", params: [`{ mode: "number" }`] };
      default:
        if (dbType.startsWith("varchar(")) {
          const length = parseVarchar(dbType);
          return { name: "varchar", params: [`{ length: ${length} }`] };
        }
        return { name: dbType };
    }
  }

  if (ctx.provider === "mysql") {
    switch (dbType) {
      case "boolean":
        return { name: "boolean" };
      case "text":
        return { name: "text" };
      case "longblob":
        return { name: generateBinaryCustomType(ctx, customTypes), isCustomType: true };
      case "bigint":
        // MySQL bigint requires mode parameter
        return { name: "bigint", params: [`{ mode: "number" }`] };
      case "integer":
        // MySQL uses "int" not "integer" in Drizzle ORM
        return { name: "int" };
      default:
        if (dbType.startsWith("varchar(")) {
          const length = parseVarchar(dbType);
          return { name: "varchar", params: [`{ length: ${length} }`] };
        }
        return { name: dbType };
    }
  }

  if (ctx.provider === "sqlite") {
    switch (dbType) {
      case "integer":
        // Need to determine the mode based on the original column type
        if (column.type === "bool") {
          return { name: "integer", params: [`{ mode: "boolean" }`] };
        }
        if (column.type === "timestamp" || column.type === "date") {
          return { name: "integer", params: [`{ mode: "timestamp" }`] };
        }
        return { name: "integer" };
      case "blob":
        // Need to determine the mode based on the original column type
        if (column.type === "bigint") {
          return { name: "blob", params: [`{ mode: "bigint" }`] };
        }
        return { name: generateBinaryCustomType(ctx, customTypes), isCustomType: true };
      case "text":
        // Check if it's JSON
        if (column.type === "json") {
          return { name: "text", params: [`{ mode: "json" }`] };
        }
        return { name: "text" };
      case "real":
        return { name: "real" };
      default:
        return { name: dbType };
    }
  }

  // Fallback for other providers
  return { name: dbType };
}

// ============================================================================
// TABLE NAME HELPERS
// ============================================================================

/**
 * Get the physical table name using the naming resolver if available
 */
function getPhysicalTableName(logicalName: string, resolver?: NamingResolver): string {
  return resolver ? resolver.getTableName(logicalName) : logicalName;
}

// ============================================================================
// COLUMN GENERATION
// ============================================================================

function generateColumnDefinition(
  ctx: GeneratorContext,
  column: AnyColumn,
  customTypes: string[],
  physicalColumnName: string,
): string {
  const parts: string[] = [];
  const typeFn = getColumnTypeFunction(ctx, column, customTypes);

  // Column type with parameters
  const params: string[] = [`"${physicalColumnName}"`, ...(typeFn.params ?? [])];
  if (!typeFn.isCustomType) {
    ctx.imports.addImport(typeFn.name, ctx.importSource);
  }
  parts.push(`${typeFn.name}(${params.join(", ")})`);

  // Primary key for internal ID
  if (column instanceof InternalIdColumn || column.role === "internal-id") {
    if (ctx.provider === "sqlite") {
      // SQLite uses primaryKey({ autoIncrement: true })
      parts.push("primaryKey({ autoIncrement: true })");
    } else if (ctx.provider === "mysql") {
      // MySQL uses primaryKey().autoincrement()
      parts.push("primaryKey()");
      parts.push("autoincrement()");
    } else {
      // PostgreSQL just uses primaryKey()
      parts.push("primaryKey()");
    }
  }

  // Nullability
  if (!column.isNullable) {
    parts.push("notNull()");
  }

  // External IDs are unique by definition in Fragno's SQL migrations.
  if (column.role === "external-id") {
    parts.push("unique()");
  }

  // Default values
  if (column.default) {
    if ("value" in column.default) {
      // Static defaults: defaultTo(value)
      let value: string;
      if (typeof column.default.value === "bigint") {
        ctx.imports.addImport("sql", "drizzle-orm");
        value = `sql\`${column.default.value.toString()}\``;
      } else {
        value = JSON.stringify(column.default.value);
      }
      parts.push(`default(${value})`);
    } else if ("dbSpecial" in column.default) {
      // Database-level special functions: defaultTo(b => b.now())
      if (column.default.dbSpecial === "now") {
        if (ctx.provider === "mysql") {
          ctx.imports.addImport("sql", "drizzle-orm");
          parts.push("default(sql`(now())`)");
        } else {
          parts.push("defaultNow()");
        }
      }
    } else if ("runtime" in column.default) {
      // Runtime defaults: defaultTo$()
      if (column.default.runtime === "cuid") {
        const idGen = ctx.idGeneratorImport ?? { name: "createId", from: "@fragno-dev/db/id" };
        ctx.imports.addImport(idGen.name, idGen.from);
        parts.push(`$defaultFn(() => ${idGen.name}())`);
      } else if (column.default.runtime === "now") {
        // Runtime-generated timestamp (not database-level)
        parts.push("$defaultFn(() => new Date())");
      }
      // Note: Custom functions in defaultTo$(() => ...) are not supported in schema generation
    }
  }

  return `  ${column.name}: ${parts.join(".")}`;
}

function generateAllColumns(
  ctx: GeneratorContext,
  table: AnyTable,
  customTypes: string[],
  resolver?: NamingResolver,
): string[] {
  return Object.values(table.columns).map((column) =>
    generateColumnDefinition(
      ctx,
      column,
      customTypes,
      resolver ? resolver.getColumnName(table.name, column.name) : column.name,
    ),
  );
}

// ============================================================================
// CONSTRAINT GENERATION
// ============================================================================

function generateForeignKeys(
  ctx: GeneratorContext,
  table: AnyTable,
  namespace?: string | null,
  resolver?: NamingResolver,
): string[] {
  const keys: string[] = [];

  for (const relation of Object.values(table.relations)) {
    // Only "one" relations generate foreign keys
    // "many" relations don't have foreign keys (they're on the other side)
    if (relation.type === "many") {
      continue;
    }

    const columns: string[] = [];
    const foreignColumns: string[] = [];
    const isSelfReference = relation.table.name === table.name;

    for (const [localCol, refCol] of relation.on) {
      columns.push(`table.${localCol}`);
      // Foreign keys always reference internal IDs
      const actualRefCol = refCol === "id" ? "_internalId" : refCol;
      // For self-referencing foreign keys, use table parameter instead of table constant
      if (isSelfReference) {
        foreignColumns.push(`table.${actualRefCol}`);
      } else {
        // Use sanitized TypeScript export name for identifier reference
        const foreignTableRef = namespace
          ? `${relation.table.name}_${sanitizeNamespace(namespace)}`
          : relation.table.name;
        foreignColumns.push(`${foreignTableRef}.${actualRefCol}`);
      }
    }

    ctx.imports.addImport("foreignKey", ctx.importSource);
    // Include namespace in FK name to avoid collisions
    const fkName = resolver
      ? resolver.getForeignKeyName({
          logicalTable: table.name,
          logicalReferencedTable: relation.table.name,
          referenceName: relation.name,
        })
      : `${table.name}_${relation.table.name}_${relation.name}_fk`;

    keys.push(`foreignKey({
  columns: [${columns.join(", ")}],
  foreignColumns: [${foreignColumns.join(", ")}],
  name: "${fkName}"
})`);
  }

  return keys;
}

function generateIndexes(
  ctx: GeneratorContext,
  table: AnyTable,
  namespace?: string | null,
  resolver?: NamingResolver,
): string[] {
  const indexes: string[] = [];

  for (const idx of Object.values(table.indexes)) {
    const columns = idx.columns.map((col) => `table.${col.name}`).join(", ");

    const indexName = resolver
      ? idx.unique
        ? resolver.getUniqueIndexName(idx.name, table.name)
        : resolver.getIndexName(idx.name, table.name)
      : namespace
        ? `${idx.name}_${namespace}`
        : idx.name;

    if (idx.unique) {
      ctx.imports.addImport("uniqueIndex", ctx.importSource);
      indexes.push(`uniqueIndex("${indexName}").on(${columns})`);
    } else {
      ctx.imports.addImport("index", ctx.importSource);
      indexes.push(`index("${indexName}").on(${columns})`);
    }
  }

  return indexes;
}

function generateTableConstraints(
  ctx: GeneratorContext,
  table: AnyTable,
  namespace?: string | null,
  resolver?: NamingResolver,
): string[] {
  const constraints: string[] = [
    ...generateForeignKeys(ctx, table, namespace, resolver),
    ...generateIndexes(ctx, table, namespace, resolver),
  ];

  if (ctx.provider === "sqlite") {
    const externalIdColumn = Object.values(table.columns).find(
      (column) => column.role === "external-id",
    );
    if (externalIdColumn) {
      const indexName = resolver
        ? resolver.getUniqueIndexName(`idx_${table.name}_external_id`, table.name)
        : namespace
          ? `idx_${table.name}_external_id_${namespace}`
          : `idx_${table.name}_external_id`;
      ctx.imports.addImport("uniqueIndex", ctx.importSource);
      constraints.push(`uniqueIndex("${indexName}").on(table.${externalIdColumn.name})`);
    }
  }

  return constraints;
}

// ============================================================================
// TABLE GENERATION
// ============================================================================

function generateTable(
  ctx: GeneratorContext,
  table: AnyTable,
  customTypes: string[],
  namespace?: string | null,
  resolver?: NamingResolver,
  schemaRef?: string,
): string {
  const tableFn = schemaRef ? `${schemaRef}.table` : PROVIDER_TABLE_FUNCTIONS[ctx.provider];
  if (!schemaRef) {
    ctx.imports.addImport(tableFn, ctx.importSource);
  }

  const columns = generateAllColumns(ctx, table, customTypes, resolver);
  const constraints = generateTableConstraints(ctx, table, namespace, resolver);

  // Physical table name in the database (respects mapper configuration)
  const physicalTableName = getPhysicalTableName(table.name, resolver);
  // TypeScript export name must always be sanitized to be a valid JavaScript identifier
  const exportName = namespace ? `${table.name}_${sanitizeNamespace(namespace)}` : table.name;

  const args: string[] = [`"${physicalTableName}"`, `{\n${columns.join(",\n")}\n}`];

  if (constraints.length > 0) {
    args.push(`(table) => [\n${ident(constraints.join(",\n"))}\n]`);
  }

  return `export const ${exportName} = ${tableFn}(${args.join(", ")})`;
}

// ============================================================================
// RELATION GENERATION
// ============================================================================

function generateRelation(
  ctx: GeneratorContext,
  table: AnyTable,
  namespace?: string | null,
  inverseRelations?: Array<{ fromTable: AnyTable; relation: Relation }>,
  _resolver?: NamingResolver,
): string | undefined {
  const relations: string[] = [];
  let hasOne = false;
  let hasMany = false;

  // Generate explicit relations defined on this table
  for (const relation of Object.values(table.relations)) {
    const options: string[] = [`relationName: "${relation.id}"`];

    // Track which relation types are used
    if (relation.type === "one") {
      hasOne = true;
    } else if (relation.type === "many") {
      hasMany = true;
    }

    // For "one" relations, specify fields and references
    if (relation.type === "one") {
      const fields: string[] = [];
      const references: string[] = [];

      // Use sanitized TypeScript export names for identifier references
      const tableRef = namespace ? `${table.name}_${sanitizeNamespace(namespace)}` : table.name;
      const relatedTableRef = namespace
        ? `${relation.table.name}_${sanitizeNamespace(namespace)}`
        : relation.table.name;

      for (const [left, right] of relation.on) {
        fields.push(`${tableRef}.${left}`);
        // Relations reference internal IDs
        const actualRight = right === "id" ? "_internalId" : right;
        references.push(`${relatedTableRef}.${actualRight}`);
      }

      options.push(`fields: [${fields.join(", ")}]`, `references: [${references.join(", ")}]`);
    }

    const relatedTableRef = namespace
      ? `${relation.table.name}_${sanitizeNamespace(namespace)}`
      : relation.table.name;

    const args: string[] = [relatedTableRef];
    if (options.length > 0) {
      args.push(`{\n${ident(options.join(",\n"))}\n}`);
    }

    relations.push(ident(`${relation.name}: ${relation.type}(${args.join(", ")})`));
  }

  // Generate inverse relations for tables that reference this table
  // Drizzle requires both sides of a relation to be defined
  if (inverseRelations && inverseRelations.length > 0) {
    for (const { fromTable, relation } of inverseRelations) {
      // Only generate inverse for "one" relations (they become "many" on this side)
      if (relation.type === "one") {
        hasMany = true;

        // Use sanitized TypeScript export name for identifier reference
        const fromTableRef = namespace
          ? `${fromTable.name}_${sanitizeNamespace(namespace)}`
          : fromTable.name;

        // Generate inverse relation name with consistent suffix
        // e.g., if session has "sessionOwner" relation to user, user gets "sessionList" inverse relation
        const inverseRelationName = `${fromTable.name}List`;

        const options: string[] = [`relationName: "${relation.id}"`];
        const args: string[] = [fromTableRef, `{\n${ident(options.join(",\n"))}\n}`];

        relations.push(ident(`${inverseRelationName}: many(${args.join(", ")})`));
      }
    }
  }

  if (relations.length === 0) {
    return undefined;
  }

  // Only include the relation types that are actually used
  const params: string[] = [];
  if (hasOne) {
    params.push("one");
  }
  if (hasMany) {
    params.push("many");
  }
  const relationParams = params.length > 0 ? `{ ${params.join(", ")} }` : "{}";

  // Use sanitized names for TypeScript export identifiers
  const exportTableRef = namespace ? `${table.name}_${sanitizeNamespace(namespace)}` : table.name;
  const relationsName = namespace ? `${exportTableRef}Relations` : `${table.name}Relations`;

  ctx.imports.addImport("relations", "drizzle-orm");
  return `export const ${relationsName} = relations(${exportTableRef}, (${relationParams}) => ({
${relations.join(",\n")}
}));`;
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Generate a schema export object for a fragment
 * This groups all tables by their logical names for easier access
 */
function generateFragmentSchemaExport(
  schema: AnySchema,
  namespace: string | null,
  tablesWithRelations?: Set<string>,
  _resolver?: NamingResolver,
): string {
  const drizzleEntries: string[] = [];

  for (const table of Object.values(schema.tables)) {
    // TypeScript export name (always sanitized for valid JS identifiers)
    const exportName = namespace ? `${table.name}_${sanitizeNamespace(namespace)}` : table.name;

    // Add physical table name to drizzle schema
    drizzleEntries.push(`  ${exportName}: ${exportName}`);

    // Include relations for this table if they exist (either explicit or inverse)
    if (tablesWithRelations?.has(table.name)) {
      const relationsName = namespace ? `${exportName}Relations` : `${table.name}Relations`;

      drizzleEntries.push(`  ${relationsName}: ${relationsName}`);
    }

    // Add convenience aliases WITH their relations to work around Drizzle bug
    // The key insight: Drizzle needs BOTH the table alias AND its relations alias
    // in the same schema object for relational queries to work
    if (namespace) {
      drizzleEntries.push(`  ${table.name}: ${exportName}`);

      // Also add the relations under the aliased name if they exist
      if (tablesWithRelations?.has(table.name)) {
        const physicalRelationsName = `${exportName}Relations`;
        const aliasRelationsName = `${table.name}Relations`;
        drizzleEntries.push(`  ${aliasRelationsName}: ${physicalRelationsName}`);
      }
    }
  }

  // Add schema version as a number
  drizzleEntries.push(`  schemaVersion: ${schema.version}`);

  // Use logical name (not physical) for the schema export variable name, sanitized for valid JS identifier
  const exportName = namespace ? `${sanitizeNamespace(namespace)}_schema` : "_schema";

  return `export const ${exportName} = {\n${drizzleEntries.join(",\n")}\n}`;
}

// ============================================================================
// MAIN GENERATION
// ============================================================================

export interface GenerateSchemaOptions {
  /** Custom ID generator import configuration */
  idGeneratorImport?: {
    /** Function name to import */
    name: string;
    /** Module to import from */
    from: string;
  };
  /** Optional naming strategy override for physical names */
  namingStrategy?: SqlNamingStrategy;
}

/**
 * Generate a settings table for storing fragment versions
 */
/**
 * Generate a schema file from one or more fragments with automatic de-duplication
 */
export function generateDrizzleSchema(
  fragments: { namespace: string | null; schema: AnySchema }[],
  provider: SupportedDatabase,
  options?: GenerateSchemaOptions,
): string {
  const ctx = createContext(provider, options?.idGeneratorImport);
  const customTypes: string[] = [];
  const sections: string[] = [];
  const namingStrategy = options?.namingStrategy ?? defaultNamingStrategyForDatabase(provider);

  for (const { schema, namespace } of fragments) {
    const fragmentTables: string[] = [];
    const resolver = createNamingResolver(schema, namespace, namingStrategy);
    const schemaName = resolver.getSchemaName();
    const schemaRef =
      ctx.provider === "postgresql" && schemaName
        ? `schema_${sanitizeNamespace(schemaName)}`
        : undefined;

    // Add section header
    fragmentTables.push("");
    fragmentTables.push(
      "// ============================================================================",
    );
    const namespaceLabel = namespace ?? "(none)";
    fragmentTables.push(`// Fragment: ${namespaceLabel}`);
    fragmentTables.push(
      "// ============================================================================",
    );

    if (schemaRef && schemaName) {
      ctx.imports.addImport("pgSchema", ctx.importSource);
      fragmentTables.push("");
      fragmentTables.push(`const ${schemaRef} = pgSchema("${schemaName}");`);
    }

    // Generate tables for this fragment
    for (const table of Object.values(schema.tables)) {
      const tableCode = generateTable(ctx, table, customTypes, namespace, resolver, schemaRef);
      fragmentTables.push("");
      fragmentTables.push(tableCode);
    }

    // Build a map of inverse relations for tables that are referenced but don't have their own relations
    // This is needed for Drizzle's relational query API to work correctly
    const inverseRelations = new Map<string, Array<{ fromTable: AnyTable; relation: Relation }>>();
    for (const table of Object.values(schema.tables)) {
      for (const relation of Object.values(table.relations)) {
        // Track this relation as an inverse on the target table
        const targetTableName = relation.table.name;
        if (!inverseRelations.has(targetTableName)) {
          inverseRelations.set(targetTableName, []);
        }
        inverseRelations.get(targetTableName)!.push({ fromTable: table, relation });
      }
    }

    // Generate relations for all tables (both explicit and inverse)
    const tablesWithRelations = new Set<string>();
    for (const table of Object.values(schema.tables)) {
      const relationCode = generateRelation(
        ctx,
        table,
        namespace,
        inverseRelations.get(table.name),
        resolver,
      );
      if (relationCode) {
        fragmentTables.push("");
        fragmentTables.push(relationCode);
        tablesWithRelations.add(table.name);
      }
    }

    // Generate schema export object (skip for internal fragment to avoid duplicate _schema exports)
    if (!(namespace === null && schema.name === internalSchema.name)) {
      fragmentTables.push("");
      fragmentTables.push(generateFragmentSchemaExport(schema, namespace, tablesWithRelations));
    }

    sections.push(...fragmentTables);
  }

  // Assemble final output
  const lines: string[] = [ctx.imports.format(), ...customTypes, ...sections];
  return lines.join("\n");
}
