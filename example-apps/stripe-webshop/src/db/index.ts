import { config } from "dotenv";
import { PGlite } from "@electric-sql/pglite";

import { drizzle } from "drizzle-orm/pglite";

import * as schema from "./schema.ts";

config({ quiet: true });

const pglite = new PGlite(process.env["DATABASE_URL"]);

const db = drizzle(pglite, { schema });

export { db };
