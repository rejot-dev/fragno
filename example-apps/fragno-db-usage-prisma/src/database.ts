import SQLite from "better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { SqliteDialect } from "kysely";
import { dbFile } from "./constants";

export { dbFile } from "./constants";

let sqliteDatabase: SQLite.Database | undefined;
let prismaClient: PrismaClient | undefined;
let sqliteDialect: SqliteDialect | undefined;

function getSqliteDatabase() {
  if (!sqliteDatabase) {
    sqliteDatabase = new SQLite(dbFile);
    sqliteDatabase.defaultSafeIntegers(true);
  }

  return sqliteDatabase;
}

export function getSqliteDialect() {
  if (!sqliteDialect) {
    sqliteDialect = new SqliteDialect({
      database: getSqliteDatabase(),
    });
  }

  return sqliteDialect;
}

export function getPrismaClient() {
  if (!prismaClient) {
    prismaClient = new PrismaClient();
  }

  return prismaClient;
}

export async function cleanup() {
  if (prismaClient) {
    await prismaClient.$disconnect();
    prismaClient = undefined;
  }
  if (sqliteDatabase) {
    sqliteDatabase.close();
    sqliteDatabase = undefined;
  }
  sqliteDialect = undefined;
}
