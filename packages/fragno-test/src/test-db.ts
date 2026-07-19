import type { IUnitOfWork } from "@fragno-dev/db";

export type TestUnitOfWorkFactory = (name?: string, config?: unknown) => IUnitOfWork;

export interface TestDb {
  createUnitOfWork: TestUnitOfWorkFactory;
}

export function createTestDb(createUnitOfWork: TestUnitOfWorkFactory): TestDb {
  return { createUnitOfWork };
}
