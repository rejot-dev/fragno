import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { db } from "../db";

export const adapter = new DrizzleAdapter({
  db,
  provider: "postgresql",
});
