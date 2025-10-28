import type { ConnectionPool } from "../../shared/connection-pool";
import type { DBType } from "./shared";

/**
 * Creates a Drizzle-specific connection pool.
 * Drizzle doesn't have a standard destroy() method, as cleanup depends on the underlying driver.
 */
export function createDrizzleConnectionPool(
  dbOrFactory: DBType | (() => DBType | Promise<DBType>),
): ConnectionPool<DBType> {
  let cachedDb: DBType | undefined;
  let initPromise: Promise<DBType> | undefined;

  const ensureInitialized = async (): Promise<DBType> => {
    if (cachedDb) {
      return cachedDb;
    }

    if (!initPromise) {
      initPromise = (async () => {
        const db =
          typeof dbOrFactory === "function"
            ? await (dbOrFactory as () => DBType | Promise<DBType>)()
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
        release: () => Promise.resolve(),
      };
    },

    getDatabaseSync() {
      if (!cachedDb) {
        throw new Error("Cannot get database synchronously: database not initialized.");
      }
      return cachedDb;
    },

    async close() {
      // Drizzle doesn't have a standard destroy() method
      // Cleanup depends on the underlying driver (e.g., PGlite, node-postgres, mysql2)
      // For now, we just clear the cache
      cachedDb = undefined;
      initPromise = undefined;
    },
  };
}
