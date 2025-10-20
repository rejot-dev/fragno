import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { schema } from "./schema/drizzle-schema";

export const pgFolder = "./fragno-db-usage.pglite" as const;
export const client = new PGlite(pgFolder);
export const db = drizzle(client, { schema });
