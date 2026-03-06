import { useFragno } from "@fragno-dev/core/react";

import type { GitHubAppFragmentPublicClientConfig } from "../github/types";
import { createGitHubAppFragmentClients } from "..";

export function createGitHubAppFragmentClient(config: GitHubAppFragmentPublicClientConfig = {}) {
  return useFragno(createGitHubAppFragmentClients(config));
}
