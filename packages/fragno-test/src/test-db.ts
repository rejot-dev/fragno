import type { IUnitOfWork } from "@fragno-dev/db";

export interface TestDb {
  createUnitOfWork: (name?: string, config?: unknown) => IUnitOfWork;
}

export function createTestDb(
  createUnitOfWork: (name?: string, config?: unknown) => IUnitOfWork,
): TestDb {
  return { createUnitOfWork };
}
