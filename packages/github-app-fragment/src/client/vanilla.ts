import { createGitHubAppFragmentClients } from "..";
import type { GitHubAppFragmentPublicClientConfig } from "../github/types";

export function createGitHubAppFragmentClient(config: GitHubAppFragmentPublicClientConfig = {}) {
  return createGitHubAppFragmentClients(config);
}
