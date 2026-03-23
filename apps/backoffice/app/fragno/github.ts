import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";

import {
  createGitHubAppFragment,
  type GitHubAppFragmentConfig,
} from "@fragno-dev/github-app-fragment";

export type GitHubConfig = Pick<
  GitHubAppFragmentConfig,
  | "appId"
  | "appSlug"
  | "privateKeyPem"
  | "webhookSecret"
  | "webhookDebug"
  | "apiBaseUrl"
  | "apiVersion"
  | "webBaseUrl"
  | "defaultLinkKey"
  | "tokenCacheTtlSeconds"
  | "webhook"
>;

export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new SqlAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

export function createGitHubServer(
  config: GitHubConfig,
  state: DurableObjectState,
): ReturnType<typeof createGitHubAppFragment> {
  return createGitHubAppFragment(config, {
    databaseAdapter: createAdapter(state),
    mountRoute: "/api/github",
  });
}

export type GitHubFragment = ReturnType<typeof createGitHubServer>;
