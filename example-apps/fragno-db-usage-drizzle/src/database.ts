import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { schema } from "./schema/drizzle-schema";

export const pgFolder = "./fragno-db-usage.pglite" as const;

type DatabaseInstance = ReturnType<typeof createDb>;

let clientInstance: PGlite | undefined;
let dbInstance: DatabaseInstance | undefined;

export function getClient(): PGlite {
  if (!clientInstance) {
    clientInstance = new PGlite(pgFolder);
  }
  return clientInstance;
}

function createDb() {
  return drizzle(getClient(), { schema });
}

export async function getDb() {
  if (!dbInstance) {
    // Simulate async database initialization (e.g., connection pool, remote connection)
    await new Promise((resolve) => setTimeout(resolve, 10));
    dbInstance = createDb();
  }
  return dbInstance;
}
