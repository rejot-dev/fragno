import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { column, idColumn, schema } from "../../schema/create";
import { writeAndLoadSchema } from "./test-utils";
import { createPreparedMigrations } from "../generic-sql/migration/prepared-migrations";

const require = createRequire(import.meta.url);
const {
  generateDrizzleJson,
  generateMigration,
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
  generateMySQLDrizzleJson,
  generateMySQLMigration,
} = require("drizzle-kit/api") as typeof import("drizzle-kit/api");

const paritySchema = schema((s) => {
  return s.addTable("items", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("name", column("string"))
      .addColumn("slug", column("varchar(64)"))
      .addColumn("count", column("integer"))
      .addColumn("isActive", column("bool"))
      .addColumn("createdAt", column("timestamp"))
      .createIndex("items_slug_idx", ["slug"], { unique: true });
  });
});

type Dialect = "postgresql" | "mysql" | "sqlite";

type NormalizationRule = {
  reason: string;
  apply: (sql: string, dialect: Dialect) => string;
};

const NORMALIZATION_RULES: NormalizationRule[] = [
  {
    reason: "Whitespace/semicolons don't change SQL semantics; normalize for stable comparisons.",
    apply: (sql) => sql.replace(/;\s*$/g, "").trim().replace(/\s+/g, " "),
  },
  {
    reason: "Identifier quoting style differs by dialect/formatter but is semantically equivalent.",
    apply: (sql) => sql.replace(/["`]/g, ""),
  },
  {
    reason: "Extra spaces around parentheses are formatting-only.",
    apply: (sql) => sql.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")"),
  },
  {
    reason: "Case is not semantically meaningful for SQL keywords/identifiers here.",
    apply: (sql) => sql.toLowerCase(),
  },
  {
    reason: "now() and CURRENT_TIMESTAMP are equivalent default expressions in these dialects.",
    apply: (sql) => sql.replace(/\bnow\(\)/g, "current_timestamp"),
  },
  {
    reason: "Column constraint order doesn't change meaning; standardize ordering.",
    apply: (sql) => sql.replace(/\bprimary key not null\b/g, "not null primary key"),
  },
  {
    reason: "SQLite autoincrement PK constraint order doesn't change meaning.",
    apply: (sql) =>
      sql.replace(/\bprimary key autoincrement not null\b/g, "not null primary key autoincrement"),
  },
  {
    reason: "Default value and NOT NULL order is equivalent in DDL.",
    apply: (sql) => sql.replace(/\bdefault\s+([^\s,]+)\s+not null\b/g, "not null default $1"),
  },
  {
    reason: "MySQL allows reordering AUTO_INCREMENT/NOT NULL/PRIMARY KEY without meaning change.",
    apply: (sql) =>
      sql.replace(
        /\bauto_increment not null primary key\b/g,
        "not null primary key auto_increment",
      ),
  },
  {
    // In PostgreSQL, NO ACTION and RESTRICT behave the same for immediate constraints,
    // but they can differ with deferrable constraints: NO ACTION can be deferred, RESTRICT is always enforced
    // immediately. So treating them as equivalent is only safe if we’re not using deferrable constraints (which we
    // aren’t in these migrations).
    reason:
      "Postgres FK action defaults to NO ACTION; Fragno uses RESTRICT. Treat as equivalent for DDL parity.",
    apply: (sql) =>
      sql
        .replace(/\bon delete no action\b/g, "on delete restrict")
        .replace(/\bon update no action\b/g, "on update restrict"),
  },
  {
    reason: "Postgres implicit public schema qualifiers are redundant in migrations.",
    apply: (sql, dialect) => (dialect === "postgresql" ? sql.replace(/\bpublic\./g, "") : sql),
  },
  {
    reason: "Postgres index method defaults to btree; explicit USING btree is redundant.",
    apply: (sql, dialect) =>
      dialect === "postgresql" ? sql.replace(/\s+using\s+btree\b/g, "") : sql,
  },
  {
    reason: "MySQL 'integer' and 'int' are synonyms; normalize for comparisons.",
    apply: (sql, dialect) => (dialect === "mysql" ? sql.replace(/\binteger\b/g, "int") : sql),
  },
];

function normalizeSql(sql: string, dialect: Dialect): string {
  let normalized = sql;
  for (const rule of NORMALIZATION_RULES) {
    normalized = rule.apply(normalized, dialect);
  }
  return normalized;
}

function normalizeStatements(statements: string[], dialect: Dialect): string[] {
  const normalized: string[] = [];
  const uniqueIdTables = new Set<string>();

  for (const statement of statements) {
    let sql = normalizeSql(statement, dialect);
    if (!sql) {
      continue;
    }

    // Canonicalize external-id uniqueness across representations.
    if (sql.startsWith("create table ")) {
      const tableMatch = sql.match(/^create table\s+(\w+)\s*\(/);
      const tableName = tableMatch?.[1];

      if (tableName) {
        const idUniqueRegex = /\bid\b([^,]*?)\bunique\b/;
        if (idUniqueRegex.test(sql)) {
          uniqueIdTables.add(tableName);
          sql = sql.replace(idUniqueRegex, "id$1");
        }

        const tableUniqueRegex = /,\s*constraint\s+\w+\s+unique\s*\(\s*id\s*\)/g;
        if (tableUniqueRegex.test(sql)) {
          uniqueIdTables.add(tableName);
          sql = sql.replace(tableUniqueRegex, "");
        }
      }
    }

    const uniqueIndexMatch = sql.match(/^create unique index\s+\w+\s+on\s+(\w+)\s*\(\s*id\s*\)/);
    if (uniqueIndexMatch) {
      uniqueIdTables.add(uniqueIndexMatch[1]);
      continue;
    }

    sql = sql.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();

    if (dialect === "mysql" && sql.startsWith("create table ")) {
      const tableMatch = sql.match(/^create table\s+(\w+)\s*\(/);
      const tableName = tableMatch?.[1];
      let pkColumn: string | undefined;

      if (tableName) {
        const uniqueRegex = /constraint\s+(\w+)\s+unique\s*\(([^)]+)\)/g;
        let match: RegExpExecArray | null;
        while ((match = uniqueRegex.exec(sql))) {
          normalized.push(`create unique index ${match[1]} on ${tableName} (${match[2]})`);
        }

        const pkMatch = sql.match(/constraint\s+\w+\s+primary key\s*\(([^)]+)\)/);
        if (pkMatch) {
          pkColumn = pkMatch[1].trim();
        }
      }

      sql = sql.replace(/,\s*constraint\s+\w+\s+unique\s*\([^)]+\)/g, "");
      sql = sql.replace(/,\s*constraint\s+\w+\s+primary key\s*\([^)]+\)/g, "");
      sql = sql.replace(/\s+,/g, ",").replace(/,\s+\)/g, ")");

      if (pkColumn) {
        const pkRegex = new RegExp(`\\b${pkColumn}\\b([^,]*?)\\bprimary key\\b`);
        if (!pkRegex.test(sql)) {
          const columnRegex = new RegExp(`\\b${pkColumn}\\b([^,]*?)\\bnot null\\b`);
          sql = sql.replace(columnRegex, `${pkColumn}$1not null primary key`);
        }
      }

      sql = sql.replace(
        /\bauto_increment not null primary key\b/g,
        "not null primary key auto_increment",
      );
    }

    normalized.push(sql);
  }

  for (const tableName of uniqueIdTables) {
    normalized.push(`__unique__ ${tableName}.id`);
  }

  return normalized.sort();
}

function isNonDdlStatement(statement: string): boolean {
  const trimmed = statement.trim().toLowerCase();
  return (
    trimmed.startsWith("pragma defer_foreign_keys") || trimmed.startsWith("set foreign_key_checks")
  );
}

async function getDrizzleMigrationSql(dialect: Dialect): Promise<string[]> {
  const result = await writeAndLoadSchema(
    `drizzle-kit-parity-${dialect}`,
    paritySchema,
    dialect,
    "",
    false,
  );

  try {
    const schemaModule = await import(`${result.schemaFilePath}?t=${Date.now()}`);
    let migrationStatements: string[];

    if (dialect === "postgresql") {
      migrationStatements = await generateMigration(
        generateDrizzleJson({}),
        generateDrizzleJson(schemaModule),
      );
    } else if (dialect === "sqlite") {
      migrationStatements = await generateSQLiteMigration(
        await generateSQLiteDrizzleJson({}),
        await generateSQLiteDrizzleJson(schemaModule),
      );
    } else {
      migrationStatements = await generateMySQLMigration(
        await generateMySQLDrizzleJson({}),
        await generateMySQLDrizzleJson(schemaModule),
      );
    }

    return migrationStatements.filter((statement) => !isNonDdlStatement(statement));
  } finally {
    await result.cleanup();
  }
}

function getKyselyMigrationSql(dialect: Dialect): string[] {
  const prepared = createPreparedMigrations({
    schema: paritySchema,
    namespace: "",
    database: dialect,
    updateVersionInMigration: false,
  });

  const statements = prepared
    .compile(0, paritySchema.version, { updateVersionInMigration: false })
    .statements.map((statement) => statement.sql);

  return statements.filter((statement) => !isNonDdlStatement(statement));
}

describe("drizzle-kit migrations match generic SQL DDL", () => {
  const cases: Dialect[] = ["postgresql", "sqlite", "mysql"];

  for (const dialect of cases) {
    it(`matches DDL for ${dialect}`, async () => {
      const drizzleSql = await getDrizzleMigrationSql(dialect);
      const kyselySql = getKyselyMigrationSql(dialect);

      const normalizedDrizzle = normalizeStatements(drizzleSql, dialect);
      const normalizedKysely = normalizeStatements(kyselySql, dialect);

      for (const [index, statement] of normalizedDrizzle.entries()) {
        expect(statement).toEqual(normalizedKysely[index]);
      }
    });
  }
});
