import { generateKeyPairSync } from "node:crypto";

import type { TableToInsertValues } from "@fragno-dev/db/query";
import type { FragnoId } from "@fragno-dev/db/schema";

import { instantiate, type AnyFragnoInstantiatedFragment } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, type TestDb } from "@fragno-dev/test";

import { githubAppRoutesFactory } from "../routes";
import { githubAppSchema } from "../schema";
import { githubAppFragmentDefinition } from "./definition";
import type { GitHubAppFragmentConfig } from "./types";

type GithubTestDb = TestDb;
type GithubTableName = keyof (typeof githubAppSchema)["tables"];

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

type FakeGitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: { login: string };
};

/** GitHub's side of one installation; tests change it and deliver a webhook announcing it. */
export type FakeGitHubInstallation = {
  account: { id: number; login: string; type: string };
  suspended: boolean;
  repositories: FakeGitHubRepository[];
};

/** Answers the app and installation-token APIs from state, the way GitHub reports it on request. */
export function createFakeGitHub(installations: Map<string, FakeGitHubInstallation>) {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  return async function fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const appInstallation = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(url.pathname);
    if (appInstallation) {
      const [, installationId, tokenPath] = appInstallation;
      const installation = installations.get(installationId);
      if (!installation) {
        return json({ message: "Not Found" }, 404);
      }
      if (tokenPath) {
        return installation.suspended
          ? json({ message: "This installation has been suspended" }, 403)
          : json({ token: `token-${installationId}`, expires_at: "2099-01-01T00:00:00Z" }, 201);
      }
      return json({
        id: Number(installationId),
        account: installation.account,
        suspended_at: installation.suspended ? "2024-01-01T00:00:00Z" : null,
        permissions: { contents: "read" },
        events: ["installation"],
      });
    }
    if (url.pathname === "/installation/repositories") {
      const installationId = request.headers.get("authorization")?.replace("token token-", "");
      const installation = installationId ? installations.get(installationId) : undefined;
      if (!installation) {
        return json({ message: "Bad credentials" }, 401);
      }
      return json({
        total_count: installation.repositories.length,
        repositories: installation.repositories,
      });
    }
    return json({ message: "Not Found" }, 404);
  };
}

/** A real key, since the app signs JWTs before every installation request. */
export const testPrivateKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs1", format: "pem" });
