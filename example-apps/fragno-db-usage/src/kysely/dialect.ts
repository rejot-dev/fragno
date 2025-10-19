import { KyselyPGlite } from "kysely-pglite";
import type { Dialect } from "kysely";

export const pgFolder = "./fragno-db-usage.pglite" as const;

let dialectInstance: Dialect | null = null;

export async function getDialect(): Promise<Dialect> {
  if (!dialectInstance) {
    const created = await KyselyPGlite.create(pgFolder);
    dialectInstance = created.dialect;
  }
  return dialectInstance;
}
