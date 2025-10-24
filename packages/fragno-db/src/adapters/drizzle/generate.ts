import { importGenerator } from "../../util/import-generator";
import { ident, parseVarchar } from "../../util/parse";
import {
  type AnyColumn,
  type AnySchema,
  type AnyTable,
  InternalIdColumn,
} from "../../schema/create";
import type { SQLProvider } from "../../shared/providers";
import { schemaToDBType, type DBTypeLiteral } from "../../schema/serialize";
import { createTableNameMapper } from "./shared";
import { settingsSchema, SETTINGS_TABLE_NAME } from "../../shared/settings-schema";

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

export type SupportedProvider = Exclude<SQLProvider, "cockroachdb" | "mssql">;

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
  provider: SupportedProvider,
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
  const code = generateCustomType(ctx, name, {
    dataType: "Uint8Array",
    driverDataType: "Buffer",
    databaseDataType: schemaToDBType({ type: "binary" }, ctx.provider),
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
 * Uses schemaToDBType as the source of truth for type conversion.
 */
function getColumnTypeFunction(
  ctx: GeneratorContext,
  column: AnyColumn,
  customTypes: string[],
): ColumnTypeFunction {
  // Get the canonical database type from schemaToDBType
  const dbType = schemaToDBType(column, ctx.provider);

  // Map database types to Drizzle function names
  return mapDBTypeToDrizzleFunction(ctx, dbType, column, customTypes);
}

/**
 * Maps a database type string to a Drizzle function name and parameters.
 */
function mapDBTypeToDrizzleFunction(
  ctx: GeneratorContext,
  dbType: DBTypeLiteral,
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
        return { name: "bigint" };
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
          return { name: "blob", params: [`{ mode: "json" }`] };
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
// COLUMN GENERATION
// ============================================================================

function generateColumnDefinition(
  ctx: GeneratorContext,
  column: AnyColumn,
  customTypes: string[],
): string {
  const parts: string[] = [];
  const typeFn = getColumnTypeFunction(ctx, column, customTypes);

  // Column type with parameters
  const params: string[] = [`"${column.name}"`, ...(typeFn.params ?? [])];
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
        parts.push("defaultNow()");
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

  return `  ${column.ormName}: ${parts.join(".")}`;
}

function generateAllColumns(
  ctx: GeneratorContext,
  table: AnyTable,
  customTypes: string[],
): string[] {
  return Object.values(table.columns).map((column) =>
    generateColumnDefinition(ctx, column, customTypes),
  );
}

// ============================================================================
// CONSTRAINT GENERATION
// ============================================================================

function generateForeignKeys(ctx: GeneratorContext, table: AnyTable, namespace?: string): string[] {
  const mapper = namespace ? createTableNameMapper(namespace) : undefined;
  const keys: string[] = [];

  for (const relation of Object.values(table.relations)) {
    // Only "one" relations generate foreign keys
    // "many" relations don't have foreign keys (they're on the other side)
    if (relation.type === "many") {
      continue;
    }

    const columns: string[] = [];
    const foreignColumns: string[] = [];
    const isSelfReference = relation.table.ormName === table.ormName;

    for (const [localCol, refCol] of relation.on) {
      columns.push(`table.${localCol}`);
      // Foreign keys always reference internal IDs
      const actualRefCol = refCol === "id" ? "_internalId" : refCol;
      // For self-referencing foreign keys, use table parameter instead of table constant
      if (isSelfReference) {
        foreignColumns.push(`table.${actualRefCol}`);
      } else {
        // Suffix the foreign table reference with namespace if provided
        const foreignTableRef =
          mapper && namespace ? mapper.toPhysical(relation.table.ormName) : relation.table.ormName;
        foreignColumns.push(`${foreignTableRef}.${actualRefCol}`);
      }
    }

    ctx.imports.addImport("foreignKey", ctx.importSource);
    // Include namespace in FK name to avoid collisions
    const fkName =
      namespace && mapper
        ? "fk_" + mapper.toPhysical(`${table.ormName}_${relation.table.ormName}_${relation.name}`)
        : `${table.ormName}_${relation.table.ormName}_${relation.name}_fk`;

    keys.push(`foreignKey({
  columns: [${columns.join(", ")}],
  foreignColumns: [${foreignColumns.join(", ")}],
  name: "${fkName}"
})`);
  }

  return keys;
}

function generateIndexes(ctx: GeneratorContext, table: AnyTable, namespace?: string): string[] {
  const indexes: string[] = [];

  for (const idx of Object.values(table.indexes)) {
    const columns = idx.columns.map((col) => `table.${col.ormName}`).join(", ");

    // Include namespace in index name to avoid collisions
    const indexName = namespace ? `${idx.name}_${namespace}` : idx.name;

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
  namespace?: string,
): string[] {
  return [...generateForeignKeys(ctx, table, namespace), ...generateIndexes(ctx, table, namespace)];
}

// ============================================================================
// TABLE GENERATION
// ============================================================================

function generateTable(
  ctx: GeneratorContext,
  table: AnyTable,
  customTypes: string[],
  namespace?: string,
): string {
  const tableFn = PROVIDER_TABLE_FUNCTIONS[ctx.provider];
  ctx.imports.addImport(tableFn, ctx.importSource);

  const columns = generateAllColumns(ctx, table, customTypes);
  const constraints = generateTableConstraints(ctx, table, namespace);

  // Suffix table name with namespace if provided
  const physicalTableName = namespace ? `${table.ormName}_${namespace}` : table.ormName;
  // Sanitize namespace for use in export name (valid JS identifier)
  const exportName = namespace ? `${table.ormName}_${sanitizeNamespace(namespace)}` : table.ormName;

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
  namespace?: string,
): string | undefined {
  const relations: string[] = [];
  let hasOne = false;
  let hasMany = false;

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

      // Use sanitized namespace for identifier references
      const tableRef = namespace
        ? `${table.ormName}_${sanitizeNamespace(namespace)}`
        : table.ormName;
      const relatedTableRef = namespace
        ? `${relation.table.ormName}_${sanitizeNamespace(namespace)}`
        : relation.table.ormName;

      for (const [left, right] of relation.on) {
        fields.push(`${tableRef}.${left}`);
        // Relations reference internal IDs
        const actualRight = right === "id" ? "_internalId" : right;
        references.push(`${relatedTableRef}.${actualRight}`);
      }

      options.push(`fields: [${fields.join(", ")}]`, `references: [${references.join(", ")}]`);
    }

    const relatedTableRef = namespace
      ? `${relation.table.ormName}_${sanitizeNamespace(namespace)}`
      : relation.table.ormName;

    const args: string[] = [relatedTableRef];
    if (options.length > 0) {
      args.push(`{\n${ident(options.join(",\n"))}\n}`);
    }

    relations.push(ident(`${relation.name}: ${relation.type}(${args.join(", ")})`));
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

  const tableRef = namespace ? `${table.ormName}_${sanitizeNamespace(namespace)}` : table.ormName;
  const relationsName = namespace
    ? `${table.ormName}_${sanitizeNamespace(namespace)}Relations`
    : `${table.ormName}Relations`;

  ctx.imports.addImport("relations", "drizzle-orm");
  return `export const ${relationsName} = relations(${tableRef}, (${relationParams}) => ({
${relations.join(",\n")}
}));`;
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Sanitize a namespace to be a valid JavaScript identifier
 * Replaces hyphens and other invalid characters with underscores
 */
function sanitizeNamespace(namespace: string): string {
  return namespace.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Generate a schema export object for a fragment
 * This groups all tables by their logical names for easier access
 */
function generateFragmentSchemaExport(schema: AnySchema, namespace: string): string {
  const entries: string[] = [];

  for (const table of Object.values(schema.tables)) {
    const physicalExportName = namespace
      ? `${table.ormName}_${sanitizeNamespace(namespace)}`
      : table.ormName;

    if (namespace) {
      const physicalTableName = namespace ? `${table.ormName}_${namespace}` : table.ormName;
      // Use physical table name as key for Drizzle schema lookups
      entries.push(`  "${physicalTableName}": ${physicalExportName}`);
    }

    // Also provide logical name for convenience
    entries.push(`  ${table.ormName}: ${physicalExportName}`);
  }

  // Add schema version as a number
  entries.push(`  schemaVersion: ${schema.version}`);

  const exportName = namespace ? `${sanitizeNamespace(namespace)}_schema` : "_schema";

  return `export const ${exportName} = {\n${entries.join(",\n")}\n}`;
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
}

/**
 * Generate a settings table for storing fragment versions
 */
function generateSettingsTable(ctx: GeneratorContext): string {
  // Use centralized settings schema

  // Extract the table from the schema
  const settingsTable =
    settingsSchema.tables[SETTINGS_TABLE_NAME as keyof typeof settingsSchema.tables];

  // Generate the table using the existing generateTable function
  const customTypes: string[] = [];
  return generateTable(ctx, settingsTable, customTypes);
}

/**
 * Generate a schema file from one or more fragments with a shared settings table
 */
export function generateSchema(
  fragments: { namespace: string; schema: AnySchema }[],
  provider: SupportedProvider,
  options?: GenerateSchemaOptions,
): string {
  const ctx = createContext(provider, options?.idGeneratorImport);
  const customTypes: string[] = [];
  const sections: string[] = [];

  // Generate settings table first
  sections.push("");
  sections.push("// ============================================================================");
  sections.push("// Settings Table (shared across all fragments)");
  sections.push("// ============================================================================");
  sections.push("");
  sections.push(generateSettingsTable(ctx));
  sections.push("");
  sections.push(`export const fragnoDbSettingSchemaVersion = ${settingsSchema.version};`);

  // Generate each fragment's tables
  for (const { namespace, schema } of fragments) {
    const fragmentTables: string[] = [];

    // Add section header
    fragmentTables.push("");
    fragmentTables.push(
      "// ============================================================================",
    );
    fragmentTables.push(`// Fragment: ${namespace}`);
    fragmentTables.push(
      "// ============================================================================",
    );

    // Generate tables for this fragment
    for (const table of Object.values(schema.tables)) {
      const tableCode = generateTable(ctx, table, customTypes, namespace);
      fragmentTables.push("");
      fragmentTables.push(tableCode);

      const relationCode = generateRelation(ctx, table, namespace);
      if (relationCode) {
        fragmentTables.push("");
        fragmentTables.push(relationCode);
      }
    }

    // Generate schema export object
    fragmentTables.push("");
    fragmentTables.push(generateFragmentSchemaExport(schema, namespace));

    sections.push(...fragmentTables);
  }

  // Assemble final output
  const lines: string[] = [ctx.imports.format(), ...customTypes, ...sections];
  return lines.join("\n");
}
