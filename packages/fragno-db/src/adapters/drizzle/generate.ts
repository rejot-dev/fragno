import { importGenerator } from "../../util/import-generator";
import { ident, parseVarchar } from "../../util/parse";
import {
  type AnyColumn,
  type AnySchema,
  type AnyTable,
  InternalIdColumn,
} from "../../schema/create";
import type { SQLProvider } from "../../shared/providers";
import { schemaToDBType } from "../../schema/serialize";

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

type SupportedProvider = Exclude<SQLProvider, "cockroachdb" | "mssql">;

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

function getColumnTypeFunction(
  ctx: GeneratorContext,
  column: AnyColumn,
  customTypes: string[],
): ColumnTypeFunction {
  // SQLite has special type mappings
  if (ctx.provider === "sqlite") {
    switch (column.type) {
      case "bigint":
        return { name: "blob", params: [`{ mode: "bigint" }`] };
      case "bool":
        return { name: "integer", params: [`{ mode: "boolean" }`] };
      case "json":
        return { name: "blob", params: [`{ mode: "json" }`] };
      case "timestamp":
      case "date":
        return { name: "integer", params: [`{ mode: "timestamp" }`] };
      case "decimal":
        return { name: "real" };
    }
  }

  // Standard type mappings
  switch (column.type) {
    case "string":
      return { name: "text" };
    case "binary":
      return { name: generateBinaryCustomType(ctx, customTypes), isCustomType: true };
    case "bool":
      return { name: "boolean" };
    case "bigint":
      // PostgreSQL requires mode parameter for bigint
      if (ctx.provider === "postgresql") {
        return { name: "bigint", params: [`{ mode: "number" }`] };
      }
      return { name: "bigint" };
    default:
      if (column.type.startsWith("varchar")) {
        return {
          name: ctx.provider === "sqlite" ? "text" : "varchar",
          params: [`{ length: ${parseVarchar(column.type)} }`],
        };
      }
      return { name: column.type };
  }
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
    parts.push("primaryKey()");

    // Auto-increment based on provider
    if (ctx.provider === "mysql" || ctx.provider === "sqlite") {
      parts.push("autoincrement()");
    }
  }

  // Nullability
  if (!column.isNullable) {
    parts.push("notNull()");
  }

  // Default values
  if (column.default) {
    if ("value" in column.default) {
      let value: string;
      if (typeof column.default.value === "bigint") {
        ctx.imports.addImport("sql", "drizzle-orm");
        value = `sql\`${column.default.value.toString()}\``;
      } else {
        value = JSON.stringify(column.default.value);
      }
      parts.push(`default(${value})`);
    } else if (column.default.runtime === "auto") {
      const idGen = ctx.idGeneratorImport ?? { name: "createId", from: "@fragno-dev/db/cuid2" };
      ctx.imports.addImport(idGen.name, idGen.from);
      parts.push(`$defaultFn(() => ${idGen.name}())`);
    } else if (column.default.runtime === "now") {
      parts.push("defaultNow()");
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

function generateForeignKeys(ctx: GeneratorContext, table: AnyTable): string[] {
  const keys: string[] = [];

  for (const relation of Object.values(table.relations)) {
    if (relation.type !== "one") {
      throw new Error(`Only one-to-one relations are supported, got ${relation.type}`);
    }

    const columns: string[] = [];
    const foreignColumns: string[] = [];

    for (const [localCol, refCol] of relation.on) {
      columns.push(`table.${localCol}`);
      // Foreign keys always reference internal IDs
      const actualRefCol = refCol === "id" ? "_internalId" : refCol;
      foreignColumns.push(`${relation.table.ormName}.${actualRefCol}`);
    }

    ctx.imports.addImport("foreignKey", ctx.importSource);
    const fkName = `${table.ormName}_${relation.table.ormName}_${relation.name}_fk`;

    keys.push(`foreignKey({
  columns: [${columns.join(", ")}],
  foreignColumns: [${foreignColumns.join(", ")}],
  name: "${fkName}"
})`);
  }

  return keys;
}

function generateIndexes(ctx: GeneratorContext, table: AnyTable): string[] {
  const indexes: string[] = [];

  for (const idx of Object.values(table.indexes)) {
    const columns = idx.columns.map((col) => `table.${col.ormName}`).join(", ");

    if (idx.unique) {
      ctx.imports.addImport("uniqueIndex", ctx.importSource);
      indexes.push(`uniqueIndex("${idx.name}").on(${columns})`);
    } else {
      ctx.imports.addImport("index", ctx.importSource);
      indexes.push(`index("${idx.name}").on(${columns})`);
    }
  }

  return indexes;
}

function generateTableConstraints(ctx: GeneratorContext, table: AnyTable): string[] {
  return [...generateForeignKeys(ctx, table), ...generateIndexes(ctx, table)];
}

// ============================================================================
// TABLE GENERATION
// ============================================================================

function generateTable(ctx: GeneratorContext, table: AnyTable, customTypes: string[]): string {
  const tableFn = PROVIDER_TABLE_FUNCTIONS[ctx.provider];
  ctx.imports.addImport(tableFn, ctx.importSource);

  const columns = generateAllColumns(ctx, table, customTypes);
  const constraints = generateTableConstraints(ctx, table);

  const args: string[] = [`"${table.ormName}"`, `{\n${columns.join(",\n")}\n}`];

  if (constraints.length > 0) {
    args.push(`(table) => [\n${ident(constraints.join(",\n"))}\n]`);
  }

  return `export const ${table.ormName} = ${tableFn}(${args.join(", ")})`;
}

// ============================================================================
// RELATION GENERATION
// ============================================================================

function generateRelation(ctx: GeneratorContext, table: AnyTable): string | undefined {
  const relations: string[] = [];

  for (const relation of Object.values(table.relations)) {
    const options: string[] = [`relationName: "${relation.id}"`];

    // For "one" relations, specify fields and references
    if (relation.type === "one") {
      const fields: string[] = [];
      const references: string[] = [];

      for (const [left, right] of relation.on) {
        fields.push(`${table.ormName}.${left}`);
        // Relations reference internal IDs
        const actualRight = right === "id" ? "_internalId" : right;
        references.push(`${relation.table.ormName}.${actualRight}`);
      }

      options.push(`fields: [${fields.join(", ")}]`, `references: [${references.join(", ")}]`);
    }

    const args: string[] = [relation.table.ormName];
    if (options.length > 0) {
      args.push(`{\n${ident(options.join(",\n"))}\n}`);
    }

    relations.push(ident(`${relation.name}: ${relation.type}(${args.join(", ")})`));
  }

  if (relations.length === 0) {
    return undefined;
  }

  ctx.imports.addImport("relations", "drizzle-orm");
  return `export const ${table.ormName}Relations = relations(${table.ormName}, ({ one, many }) => ({
${relations.join(",\n")}
}));`;
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

export function generateSchema(
  schema: AnySchema,
  provider: SupportedProvider,
  options?: GenerateSchemaOptions,
): string {
  const ctx = createContext(provider, options?.idGeneratorImport);
  const customTypes: string[] = [];
  const tables: string[] = [];

  // Generate tables and collect custom types
  for (const table of Object.values(schema.tables)) {
    // Custom types might be generated during column processing
    const tableCode = generateTable(ctx, table, customTypes);
    tables.push(tableCode);

    const relationCode = generateRelation(ctx, table);
    if (relationCode) {
      tables.push(relationCode);
    }
  }

  // Assemble final output
  const lines: string[] = [ctx.imports.format(), ...customTypes, ...tables];
  return lines.join("\n\n");
}
