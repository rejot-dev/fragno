import { KyselyAdapter } from "@fragno-dev/db/adapters/kysely";
import { db } from "../database";

export function createAdapter() {
  return new KyselyAdapter({
    db,
    provider: "postgresql",
  });
}
export const adapter = createAdapter();
