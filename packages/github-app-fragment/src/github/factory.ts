import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { githubAppFragmentDefinition, type GitHubAppFragmentServices } from "./definition";
import { githubAppRoutesFactory } from "../routes";
import type { GitHubAppFragmentConfig } from "./types";

export function createGitHubAppFragment(
  config: GitHubAppFragmentConfig,
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(githubAppFragmentDefinition)
    .withConfig(config)
    .withRoutes([githubAppRoutesFactory])
    .withOptions(options)
    .build();
}

export function getGitHubApiClientFromFragment(fragment: { services: GitHubAppFragmentServices }) {
  return fragment.services.githubApiClient;
}

export function getGitHubAppFromFragment(fragment: { services: GitHubAppFragmentServices }) {
  return fragment.services.app;
}
