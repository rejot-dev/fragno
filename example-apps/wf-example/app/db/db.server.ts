import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { schema } from "./schema";

export const postgresUrl =
  process.env["WF_EXAMPLE_DATABASE_URL"] ??
  process.env["DATABASE_URL"] ??
  "postgres://postgres:postgres@localhost:5436/wilco";

type DatabaseInstance = ReturnType<typeof createDrizzleDatabase>;

let poolInstance: Pool | undefined;
let dbInstance: DatabaseInstance | undefined;

export function getPostgresPool(): Pool {
  if (!poolInstance) {
    poolInstance = new Pool({ connectionString: postgresUrl });
    poolInstance.on("error", (error) => {
      console.error("Postgres pool error", error);
      const poolToClose = poolInstance;
      poolInstance = undefined;
      dbInstance = undefined;
      void poolToClose?.end().catch((closeError) => {
        console.error("Failed to close Postgres pool", closeError);
      });
    });
  }
  return poolInstance;
}

function createDrizzleDatabase() {
  return drizzle(getPostgresPool(), { schema });
}

export async function getDrizzleDatabase() {
  if (!dbInstance) {
    dbInstance = createDrizzleDatabase();
  }
  return dbInstance;
}
