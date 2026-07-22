import { useFragno } from "@fragno-dev/core/solid";

import { createGitHubAppFragmentClients } from "../github/clients";
import type { GitHubAppFragmentPublicClientConfig } from "../github/types";

export function createGitHubAppFragmentClient(config: GitHubAppFragmentPublicClientConfig = {}) {
  return useFragno(createGitHubAppFragmentClients(config));
}
