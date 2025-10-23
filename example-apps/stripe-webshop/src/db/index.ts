import { config } from "dotenv";

import { drizzle } from "drizzle-orm/pglite";

import * as schema from "./schema.ts";

config({ quiet: true });

const db = drizzle({
  connection: {
    dataDir: process.env["DATABASE_URL"],
  },
  schema,
});

export { db };
