import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { schema } from "./schema/drizzle-schema";

export const pgFolder = "./fragno-db-usage.pglite" as const;

let clientInstance: PGlite | undefined;
let dbInstance: ReturnType<typeof drizzle> | undefined;

export function getClient(): PGlite {
  if (!clientInstance) {
    clientInstance = new PGlite(pgFolder);
  }
  return clientInstance;
}

export async function getDb() {
  if (!dbInstance) {
    // Simulate async database initialization (e.g., connection pool, remote connection)
    await new Promise((resolve) => setTimeout(resolve, 10));
    dbInstance = drizzle(getClient(), { schema });
  }
  return dbInstance;
}
