import { Pool } from "pg";

export const postgresUrl =
  process.env.WF_EXAMPLE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5436/wilco";

let poolInstance: Pool | undefined;

export function getPostgresPool(): Pool {
  if (!poolInstance) {
    poolInstance = new Pool({ connectionString: postgresUrl });
    poolInstance.on("error", (error) => {
      console.error("Postgres pool error", error);
      const poolToClose = poolInstance;
      poolInstance = undefined;
      void poolToClose?.end().catch((closeError: unknown) => {
        console.error("Failed to close Postgres pool", closeError);
      });
    });
  }
  return poolInstance;
}
