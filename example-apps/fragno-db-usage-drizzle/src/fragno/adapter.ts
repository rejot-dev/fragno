import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { getDb } from "../database";

export function createAdapter() {
  return new DrizzleAdapter({
    db: getDb,
    provider: "postgresql",
  });
}

export const adapter = createAdapter();
