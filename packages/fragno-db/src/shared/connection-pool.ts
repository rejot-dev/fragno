/**
 * Represents an active database connection that can be released back to the pool.
 */
export interface Connection<TDb> {
  db: TDb;
  release(): Promise<void>;
}

/**
 * Connection pool interface for managing database connections.
 * Adapter-specific implementations should be used (e.g., createKyselyConnectionPool, createDrizzleConnectionPool).
 */
export interface ConnectionPool<TDb> {
  /** Acquire a connection from the pool */
  connect(): Promise<Connection<TDb>>;
  /**
   * Get the database instance synchronously. Only works if the pool has already been initialized
   * via connect().
   * @throws an error if called before the pool is initialized.
   */
  getDatabaseSync(): TDb;
  /** Close the pool and cleanup resources */
  close(): Promise<void>;
}
