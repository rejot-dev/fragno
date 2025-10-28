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

export function getDb() {
  if (!dbInstance) {
    dbInstance = drizzle(getClient(), { schema });
  }
  return dbInstance;
}
