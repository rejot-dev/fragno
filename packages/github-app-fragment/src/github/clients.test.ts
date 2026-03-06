import { describe, expect, it } from "vitest";

import { createGitHubAppFragmentClients } from "./clients";
import { createGitHubAppFragmentClient } from "../client/vanilla";

describe("github-app-fragment clients", () => {
  it("creates the vanilla client wrapper", () => {
    const client = createGitHubAppFragmentClient();
    expect(client).toHaveProperty("useSyncInstallation");
    expect(client.useSyncInstallation).toMatchObject({
      mutateQuery: expect.any(Function),
      mutatorStore: expect.objectContaining({ mutate: expect.any(Function) }),
    });
  });

  it("creates clients from the base builder", () => {
    const client = createGitHubAppFragmentClients({});
    expect(client).toHaveProperty("useSyncInstallation");
    expect(client.useSyncInstallation).toMatchObject({
      mutateQuery: expect.any(Function),
      mutatorStore: expect.objectContaining({ mutate: expect.any(Function) }),
    });
  });
});
