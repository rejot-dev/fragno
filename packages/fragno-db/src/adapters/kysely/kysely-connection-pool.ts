import type { Kysely } from "kysely";
import type { ConnectionPool } from "../../shared/connection-pool";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

/**
 * Creates a Kysely-specific connection pool with proper cleanup.
 * Calls db.destroy() when the pool is closed to properly release database connections.
 */
export function createKyselyConnectionPool(
  dbOrFactory: KyselyAny | (() => KyselyAny | Promise<KyselyAny>),
): ConnectionPool<KyselyAny> {
  let cachedDb: KyselyAny | undefined;
  let initPromise: Promise<KyselyAny> | undefined;

  const ensureInitialized = async (): Promise<KyselyAny> => {
    if (cachedDb) {
      return cachedDb;
    }

    if (!initPromise) {
      initPromise = (async () => {
        const db =
          typeof dbOrFactory === "function"
            ? await (dbOrFactory as () => KyselyAny | Promise<KyselyAny>)()
            : dbOrFactory;
        cachedDb = db;
        return db;
      })();
    }

    return initPromise;
  };

  // Eagerly start initialization if it's a factory function
  if (typeof dbOrFactory === "function") {
    void ensureInitialized();
  } else {
    // Direct instance - cache it immediately
    cachedDb = dbOrFactory;
  }

  return {
    async connect() {
      const db = await ensureInitialized();

      return {
        db,
        release: async () => {},
      };
    },

    getDatabaseSync() {
      if (!cachedDb) {
        throw new Error("Cannot get database synchronously: database not initialized.");
      }
      return cachedDb;
    },

    async close() {
      if (cachedDb) {
        // Properly destroy Kysely instance to close all connections
        await cachedDb.destroy();
      }
      cachedDb = undefined;
      initPromise = undefined;
    },
  };
}
