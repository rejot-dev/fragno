import { createFragnoReactClient } from "@fragno-dev/core/react";

import { createGitHubAppFragmentClients } from "../github/clients";
import type { GitHubAppFragmentPublicClientConfig } from "../github/types";

export function createGitHubAppFragmentClient(config: GitHubAppFragmentPublicClientConfig = {}) {
  return createFragnoReactClient(createGitHubAppFragmentClients(config));
}
