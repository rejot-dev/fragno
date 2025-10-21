import { config } from "dotenv";

import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";

import * as schema from "./schema.ts";

config({ quiet: true });

const sqlite = new Database(process.env["DATABASE_URL"]);
export const db = drizzle(sqlite, { schema });
