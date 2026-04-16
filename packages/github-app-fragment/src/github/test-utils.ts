import type { TableToInsertValues } from "@fragno-dev/db/query";
import type { FragnoId } from "@fragno-dev/db/schema";

import { instantiate, type AnyFragnoInstantiatedFragment } from "@fragno-dev/core";
import type { TypedUnitOfWork } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, type TestDb } from "@fragno-dev/test";

import { githubAppRoutesFactory } from "../routes";
import { githubAppSchema } from "../schema";
import { githubAppFragmentDefinition } from "./definition";
import type { GitHubAppFragmentConfig } from "./types";

type GithubTestDb = TestDb;
type GithubUow = TypedUnitOfWork<typeof githubAppSchema>;
type GithubTableName = keyof (typeof githubAppSchema)["tables"] & string;

/** Run one or more `create` calls in a single unit of work (replaces removed `db.create` helper). */
export async function runGithubUowCreates(
  db: GithubTestDb,
  uowName: string,
  fn: (uow: GithubUow) => void,
): Promise<void> {
  const uow = db.createUnitOfWork(uowName).forSchema(githubAppSchema);
  fn(uow);
  const { success } = await uow.executeMutations();
  if (!success) {
    throw new Error("Failed to create records");
  }
}

export async function runGithubUowCreate<TTableName extends GithubTableName>(
  db: GithubTestDb,
  uowName: string,
  table: TTableName,
  values: TableToInsertValues<(typeof githubAppSchema)["tables"][TTableName]>,
): Promise<FragnoId> {
  const uow = db.createUnitOfWork(uowName).forSchema(githubAppSchema);
  uow.create(table, values);
  const { success } = await uow.executeMutations();
  if (!success) {
    throw new Error("Failed to create record");
  }
  const id = uow.getCreatedIds()[0];
  if (!id) {
    throw new Error("Failed to get created ID");
  }
  return id;
}

export type GitHubAppFragmentsTest = {
  fragments: {
    githubApp: {
      fragment: AnyFragnoInstantiatedFragment;
      callRoute: (...args: unknown[]) => Promise<unknown>;
      db: GithubTestDb;
    };
  };
  test: {
    cleanup: () => Promise<void>;
    resetDatabase: () => Promise<void>;
  };
};

export const buildHarness = async (
  config: GitHubAppFragmentConfig,
): Promise<GitHubAppFragmentsTest> => {
  const result = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "githubApp",
      instantiate(githubAppFragmentDefinition)
        .withConfig(config)
        .withRoutes([githubAppRoutesFactory]),
    )
    .build();
  return result as GitHubAppFragmentsTest;
};
