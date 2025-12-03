import type { DatabaseConnection, Driver } from "../sql-driver";

export interface ConnectionProvider {
  /**
   * Provides a connection for the callback and takes care of disposing
   * the connection after the callback has been run.
   */
  provideConnection<T>(consumer: (connection: DatabaseConnection) => Promise<T>): Promise<T>;
}

export class DefaultConnectionProvider implements ConnectionProvider {
  readonly #driver: Driver;

  constructor(driver: Driver) {
    this.#driver = driver;
  }

  async provideConnection<T>(consumer: (connection: DatabaseConnection) => Promise<T>): Promise<T> {
    const connection = await this.#driver.acquireConnection();

    try {
      return await consumer(connection);
    } finally {
      await this.#driver.releaseConnection(connection);
    }
  }
}
