import { createGitHubAppFragmentClients } from "../github/clients";
import type { GitHubAppFragmentPublicClientConfig } from "../github/types";

export function createGitHubAppFragmentClient(config: GitHubAppFragmentPublicClientConfig = {}) {
  return createGitHubAppFragmentClients(config);
}
