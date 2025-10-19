import { createFragnoDatabase } from "@fragno-dev/db";
import { commentSchema } from "@fragno-dev/fragno-db-library";
import { KyselyAdapter } from "@fragno-dev/db/adapters/kysely";
import { getDb } from "./database";

/**
 * FragnoDatabase instance with lazy adapter initialization.
 * The adapter is created on-demand to avoid database connection during CLI imports.
 */
export const boundCommentLib = createFragnoDatabase({
  namespace: "fragno-db-comment-library",
  schema: commentSchema,
  getAdapter: async () => {
    const db = await getDb();
    return new KyselyAdapter({
      db,
      provider: "postgresql",
    });
  },
});
