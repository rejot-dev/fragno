import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { schema } from "./schema";

export const pgFile = process.env["WF_EXAMPLE_DB"] ?? ("./wf-example.pglite" as const);

type DatabaseInstance = ReturnType<typeof createDrizzleDatabase>;

let clientInstance: PGlite | undefined;
let dbInstance: DatabaseInstance | undefined;

export function getPgliteClient(): PGlite {
  if (!clientInstance) {
    clientInstance = new PGlite(pgFile);
  }
  return clientInstance;
}

function createDrizzleDatabase() {
  return drizzle(getPgliteClient(), { schema });
}

async function ensureSchema() {
  const client = getPgliteClient();
  await client.query(`
    create table if not exists workflow_run (
      id serial primary key,
      name text not null,
      status text not null,
      step_count integer not null default 0,
      created_at timestamp not null default now()
    )
  `);
}

export async function getDrizzleDatabase() {
  if (!dbInstance) {
    await ensureSchema();
    dbInstance = createDrizzleDatabase();
  }
  return dbInstance;
}
