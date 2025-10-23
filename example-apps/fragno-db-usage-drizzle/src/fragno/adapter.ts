import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { db } from "../database";

export function createAdapter() {
  return new DrizzleAdapter({
    db,
    provider: "postgresql",
  });
}

export const adapter = createAdapter();
