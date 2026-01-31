import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
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
  return s
    .addTable("users", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("email", column("varchar(255)"))
        .addColumn("name", column("string"))
        .addColumn("status", column("varchar(32)").defaultTo("active"))
        .addColumn("isActive", column("bool").defaultTo(true))
        .addColumn("loginCount", column("integer").defaultTo(0))
        .addColumn("bigCounter", column("bigint"))
        .addColumn("score", column("decimal").defaultTo(0))
        .addColumn("profile", column("json").nullable())
        .addColumn("avatar", column("binary").nullable())
        .addColumn("birthday", column("date").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo$((b) => b.now()),
        )
        .createIndex("users_email_idx", ["email"], { unique: true })
        .createIndex("users_status_idx", ["status"]);
    })
    .addTable("posts", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("slug", column("varchar(64)"))
        .addColumn("body", column("string"))
        .addColumn("published", column("bool").defaultTo(false))
        .addColumn("publishedAt", column("timestamp").nullable())
        .addColumn("authorId", referenceColumn())
        .addColumn("metadata", column("json").nullable())
        .addColumn("rating", column("decimal").nullable())
        .addColumn("contentHash", column("binary").nullable())
        .createIndex("posts_slug_idx", ["slug"], { unique: true })
        .createIndex("posts_author_idx", ["authorId"])
        .createIndex("posts_author_title_idx", ["authorId", "title"], { unique: true });
    })
    .addTable("tags", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("label", column("string"))
        .addColumn("slug", column("varchar(32)"))
        .createIndex("tags_slug_idx", ["slug"], { unique: true });
    })
    .addTable("postTags", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("postId", referenceColumn())
        .addColumn("tagId", referenceColumn())
        .addColumn(
          "addedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("post_tags_post_idx", ["postId"])
        .createIndex("post_tags_tag_idx", ["tagId"])
        .createIndex("post_tags_unique_idx", ["postId", "tagId"], { unique: true });
    })
    .addTable("categories", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("parentId", referenceColumn().nullable())
        .createIndex("categories_parent_idx", ["parentId"]);
    })
    .addReference("posts_author", {
      type: "one",
      from: { table: "posts", column: "authorId" },
      to: { table: "users", column: "id" },
    })
    .addReference("post_tags_post", {
      type: "one",
      from: { table: "postTags", column: "postId" },
      to: { table: "posts", column: "id" },
    })
    .addReference("post_tags_tag", {
      type: "one",
      from: { table: "postTags", column: "tagId" },
      to: { table: "tags", column: "id" },
    })
    .addReference("categories_parent", {
      type: "one",
      from: { table: "categories", column: "parentId" },
      to: { table: "categories", column: "id" },
    });
});

type Dialect = "postgresql" | "mysql" | "sqlite";

type NormalizationRule = {
  reason: string;
  apply: (sql: string, dialect: Dialect) => string;
};

type StatementNormalizationContext = {
  dialect: Dialect;
  uniqueIdTables: Set<string>;
  foreignKeys: Set<string>;
  extraStatements: string[];
  nameMarkers: string[];
};

type StatementNormalizationRule = {
  reason: string;
  apply: (sql: string, ctx: StatementNormalizationContext) => string | null;
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
    reason: "DEFAULT (current_timestamp) is equivalent to DEFAULT current_timestamp.",
    apply: (sql) => sql.replace(/\bdefault\s+\(current_timestamp\)/g, "default current_timestamp"),
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
  {
    reason: "Postgres 'numeric' and 'decimal' are synonyms; normalize for comparisons.",
    apply: (sql, dialect) =>
      dialect === "postgresql" ? sql.replace(/\bnumeric\b/g, "decimal") : sql,
  },
];

const STATEMENT_NORMALIZATION_RULES: StatementNormalizationRule[] = [
  {
    reason:
      "External-id uniqueness can appear as column UNIQUE or a table-level UNIQUE(id); normalize to markers.",
    apply: (sql, ctx) => {
      if (!sql.startsWith("create table ")) {
        return sql;
      }

      const tableMatch = sql.match(/^create table\s+(\w+)\s*\(/);
      const tableName = tableMatch?.[1];
      if (!tableName) {
        return sql;
      }

      const idUniqueRegex = /\bid\b([^,]*?)\bunique\b/;
      if (idUniqueRegex.test(sql)) {
        ctx.uniqueIdTables.add(tableName);
        sql = sql.replace(idUniqueRegex, "id$1");
      }

      const tableUniqueRegex = /,\s*constraint\s+\w+\s+unique\s*\(\s*id\s*\)/g;
      if (tableUniqueRegex.test(sql)) {
        ctx.uniqueIdTables.add(tableName);
        sql = sql.replace(tableUniqueRegex, "");
      }

      return sql;
    },
  },
  {
    reason:
      "SQLite emits inline FK constraints on CREATE TABLE; normalize them to markers for parity.",
    apply: (sql, ctx) => {
      if (!sql.startsWith("create table ") || !sql.includes(" foreign key ")) {
        return sql;
      }

      const tableMatch = sql.match(/^create table\s+(\w+)\s*\(/);
      const tableName = tableMatch?.[1];
      if (!tableName) {
        return sql;
      }

      const fkRegex =
        /,\s*(?:constraint\s+(\w+)\s+)?foreign key\s*\(([^)]+)\)\s+references\s+(\w+)\s*\(([^)]+)\)(?:\s+on delete\s+(\w+))?(?:\s+on update\s+(\w+))?/g;

      let match: RegExpExecArray | null;
      while ((match = fkRegex.exec(sql))) {
        const constraintName = match[1]?.trim();
        const columns = match[2].replace(/\s+/g, " ").trim();
        const referencedTable = match[3].trim();
        const referencedColumns = match[4].replace(/\s+/g, " ").trim();
        const onDelete = (match[5] ?? "restrict").trim();
        const onUpdate = (match[6] ?? "restrict").trim();
        ctx.foreignKeys.add(
          `__fk__ ${tableName}(${columns})->${referencedTable}(${referencedColumns}) on delete ${onDelete} on update ${onUpdate}`,
        );
        if (constraintName) {
          ctx.nameMarkers.push(
            `__fkname__ ${tableName}.${constraintName}(${columns})->${referencedTable}(${referencedColumns}) on delete ${onDelete} on update ${onUpdate}`,
          );
        }
      }

      return sql.replace(fkRegex, "");
    },
  },
  {
    reason: "Drizzle can emit inline column REFERENCES; normalize these to FK markers for parity.",
    apply: (sql, ctx) => {
      if (!sql.startsWith("create table ") || !sql.includes(" references ")) {
        return sql;
      }

      const tableMatch = sql.match(/^create table\s+(\w+)\s*\(/);
      const tableName = tableMatch?.[1];
      if (!tableName) {
        return sql;
      }

      const referencesRegex =
        /\b(\w+)\b([^,]*?)\s+references\s+(\w+)\s*\(([^)]+)\)(?:\s+on delete\s+(\w+))?(?:\s+on update\s+(\w+))?/g;
      let match: RegExpExecArray | null;

      while ((match = referencesRegex.exec(sql))) {
        const columnName = match[1].trim();
        const referencedTable = match[3].trim();
        const referencedColumns = match[4].replace(/\s+/g, " ").trim();
        const onDelete = (match[5] ?? "restrict").trim();
        const onUpdate = (match[6] ?? "restrict").trim();
        ctx.foreignKeys.add(
          `__fk__ ${tableName}(${columnName})->${referencedTable}(${referencedColumns}) on delete ${onDelete} on update ${onUpdate}`,
        );
      }

      return sql.replace(referencesRegex, "$1$2");
    },
  },
  {
    reason:
      "FK action clauses without any remaining FK/REFERENCES are orphaned; strip to avoid false diffs.",
    apply: (sql) => {
      if (
        sql.startsWith("create table ") &&
        !sql.includes(" references ") &&
        !sql.includes(" foreign key ") &&
        sql.includes(" on delete ")
      ) {
        return sql.replace(/\s+on delete\s+\w+/g, "").replace(/\s+on update\s+\w+/g, "");
      }
      return sql;
    },
  },
  {
    reason: "ALTER TABLE ADD FOREIGN KEY is equivalent to inline FK markers; normalize and drop.",
    apply: (sql, ctx) => {
      if (!sql.startsWith("alter table ") || !sql.includes(" foreign key ")) {
        return sql;
      }

      const tableMatch = sql.match(/^alter table\s+(\w+)\s+/);
      const tableName = tableMatch?.[1];
      const fkRegex =
        /(?:constraint\s+(\w+)\s+)?foreign key\s*\(([^)]+)\)\s+references\s+(\w+)\s*\(([^)]+)\)(?:\s+on delete\s+(\w+))?(?:\s+on update\s+(\w+))?/g;

      if (tableName) {
        let match: RegExpExecArray | null;
        while ((match = fkRegex.exec(sql))) {
          const constraintName = match[1]?.trim();
          const columns = match[2].replace(/\s+/g, " ").trim();
          const referencedTable = match[3].trim();
          const referencedColumns = match[4].replace(/\s+/g, " ").trim();
          const onDelete = (match[5] ?? "restrict").trim();
          const onUpdate = (match[6] ?? "restrict").trim();
          ctx.foreignKeys.add(
            `__fk__ ${tableName}(${columns})->${referencedTable}(${referencedColumns}) on delete ${onDelete} on update ${onUpdate}`,
          );
          if (constraintName) {
            ctx.nameMarkers.push(
              `__fkname__ ${tableName}.${constraintName}(${columns})->${referencedTable}(${referencedColumns}) on delete ${onDelete} on update ${onUpdate}`,
            );
          }
        }
      }

      return null;
    },
  },
  {
    reason:
      "Some adapters emit a dedicated unique index for external IDs; normalize to external-id markers.",
    apply: (sql, ctx) => {
      const uniqueIndexMatch = sql.match(/^create unique index\s+\w+\s+on\s+(\w+)\s*\(\s*id\s*\)/);
      if (!uniqueIndexMatch) {
        return sql;
      }

      ctx.uniqueIdTables.add(uniqueIndexMatch[1]);
      return null;
    },
  },
  {
    reason:
      "MySQL inline constraints are semantically equivalent to separate statements; normalize to indexes and column PK.",
    apply: (sql, ctx) => {
      if (ctx.dialect !== "mysql" || !sql.startsWith("create table ")) {
        return sql;
      }

      const tableMatch = sql.match(/^create table\s+(\w+)\s*\(/);
      const tableName = tableMatch?.[1];
      let pkColumn: string | undefined;
      let pkConstraintName: string | undefined;

      if (tableName) {
        const uniqueRegex = /constraint\s+(\w+)\s+unique\s*\(([^)]+)\)/g;
        let match: RegExpExecArray | null;
        while ((match = uniqueRegex.exec(sql))) {
          ctx.extraStatements.push(`create unique index ${match[1]} on ${tableName} (${match[2]})`);
        }

        const pkMatch = sql.match(/constraint\s+(\w+)\s+primary key\s*\(([^)]+)\)/);
        if (pkMatch) {
          pkConstraintName = pkMatch[1].trim();
          pkColumn = pkMatch[2].trim();
        }
      }

      sql = sql.replace(/,\s*constraint\s+\w+\s+unique\s*\([^)]+\)/g, "");
      sql = sql.replace(/,\s*constraint\s+\w+\s+primary key\s*\([^)]+\)/g, "");
      sql = sql.replace(/\s+,/g, ",").replace(/,\s+\)/g, ")");

      if (pkColumn) {
        if (tableName && pkConstraintName) {
          ctx.nameMarkers.push(`__pkname__ ${tableName}.${pkConstraintName}(${pkColumn})`);
        }

        const pkRegex = new RegExp(`\\b${pkColumn}\\b([^,]*?)\\bprimary key\\b`);
        if (!pkRegex.test(sql)) {
          const columnRegex = new RegExp(`\\b${pkColumn}\\b([^,]*?)\\bnot null\\b`);
          sql = sql.replace(columnRegex, `${pkColumn}$1not null primary key`);
        }
      }

      return sql.replace(
        /\bauto_increment not null primary key\b/g,
        "not null primary key auto_increment",
      );
    },
  },
  {
    reason: "Normalize commas/spaces for deterministic statement ordering.",
    apply: (sql) =>
      sql
        .replace(/\s+/g, " ")
        .replace(/\s+,/g, ",")
        .replace(/,\s+/g, ",")
        .replace(/,\s*\)/g, ")")
        .trim(),
  },
];

function normalizeSql(sql: string, dialect: Dialect): string {
  let normalized = sql;
  for (const rule of NORMALIZATION_RULES) {
    normalized = rule.apply(normalized, dialect);
  }
  return normalized;
}

function applyStatementNormalization(
  sql: string,
  ctx: StatementNormalizationContext,
): string | null {
  let normalized = sql;
  for (const rule of STATEMENT_NORMALIZATION_RULES) {
    const next = rule.apply(normalized, ctx);
    if (next === null) {
      return null;
    }
    normalized = next;
  }
  return normalized;
}

function normalizeStatements(statements: string[], dialect: Dialect): string[] {
  const normalized: string[] = [];
  const context: StatementNormalizationContext = {
    dialect,
    uniqueIdTables: new Set<string>(),
    foreignKeys: new Set<string>(),
    extraStatements: [],
    nameMarkers: [],
  };

  for (const statement of statements) {
    const normalizedSql = normalizeSql(statement, dialect);
    let sql = normalizedSql;
    if (!sql) {
      continue;
    }

    const normalizedStatement = applyStatementNormalization(sql, context);
    if (normalizedStatement) {
      normalized.push(normalizedStatement);
    }
  }

  for (const tableName of context.uniqueIdTables) {
    normalized.push(`__unique__ ${tableName}.id`);
  }

  for (const fk of context.foreignKeys) {
    normalized.push(fk);
  }

  for (const marker of context.nameMarkers) {
    const normalizedMarker = applyStatementNormalization(
      normalizeSql(marker, context.dialect),
      context,
    );
    if (normalizedMarker) {
      normalized.push(normalizedMarker);
    }
  }

  for (const extra of context.extraStatements) {
    const normalizedExtra = applyStatementNormalization(
      normalizeSql(extra, context.dialect),
      context,
    );
    if (normalizedExtra) {
      normalized.push(normalizedExtra);
    }
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
      expect(normalizedDrizzle.length).toEqual(normalizedKysely.length);
    });
  }
});
