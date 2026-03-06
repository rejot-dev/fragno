import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate, type AnyFragnoInstantiatedFragment } from "@fragno-dev/core";

import { githubAppFragmentDefinition } from "./definition";
import { githubAppRoutesFactory } from "../routes";
import type { GitHubAppFragmentConfig } from "./types";

export type GitHubAppFragmentsTest = {
  fragments: {
    githubApp: {
      fragment: AnyFragnoInstantiatedFragment;
      callRoute: (...args: unknown[]) => Promise<unknown>;
      db: {
        create: (...args: unknown[]) => Promise<unknown>;
        find: (...args: unknown[]) => Promise<unknown>;
      };
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
