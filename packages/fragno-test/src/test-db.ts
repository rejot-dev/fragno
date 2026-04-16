import type { FragnoDatabase, IUnitOfWork } from "@fragno-dev/db";

export interface TestDb {
  createUnitOfWork: (name?: string, config?: unknown) => IUnitOfWork;
}

export function createTestDb(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getDatabase: () => FragnoDatabase<any, any>,
): TestDb {
  return {
    createUnitOfWork: (name?: string, config?: unknown) => {
      return getDatabase().createBaseUnitOfWork(name, config as never);
    },
  };
}
