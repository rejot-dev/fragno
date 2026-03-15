import { useFragno } from "@fragno-dev/core/svelte";

import { createGitHubAppFragmentClients } from "..";
import type { GitHubAppFragmentPublicClientConfig } from "../github/types";

export function createGitHubAppFragmentClient(config: GitHubAppFragmentPublicClientConfig = {}) {
  return useFragno(createGitHubAppFragmentClients(config));
}
