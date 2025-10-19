import { Kysely } from "kysely";
import type { KyselyDatabase } from "./kysely-types";
import { getDialect } from "./kysely/dialect";

let dbInstance: Kysely<KyselyDatabase> | null = null;

export async function getDb(): Promise<Kysely<KyselyDatabase>> {
  if (!dbInstance) {
    const dialect = await getDialect();
    dbInstance = new Kysely<KyselyDatabase>({
      dialect: dialect,
    });
  }
  return dbInstance;
}
