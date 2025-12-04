import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { schema } from "./schema/drizzle-schema";

export const pgFolder = "./fragno-db-usage.pglite" as const;

type DatabaseInstance = ReturnType<typeof createDrizzleDatabase>;

let clientInstance: PGlite | undefined;
let dbInstance: DatabaseInstance | undefined;

export function getPGLiteClient(): PGlite {
  if (!clientInstance) {
    clientInstance = new PGlite(pgFolder);
  }
  return clientInstance;
}

function createDrizzleDatabase() {
  return drizzle(getPGLiteClient(), { schema });
}

export async function getDrizzleDatabase() {
  if (!dbInstance) {
    // Simulate async database initialization (e.g., connection pool, remote connection)
    await new Promise((resolve) => setTimeout(resolve, 10));
    dbInstance = createDrizzleDatabase();
  }
  return dbInstance;
}
