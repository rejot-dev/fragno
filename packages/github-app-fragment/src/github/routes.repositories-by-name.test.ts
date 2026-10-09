import { describe, expect, it } from "vitest";

import { buildHarness, runGithubUowCreate } from "./test-utils";

const config = {
  appId: "42",
  appSlug: "test-app",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  callbackUrl: "https://example.com/github/callback",
  privateKeyPem: "test-key",
  webhookSecret: "secret",
};
const pathParams = { owner: "octo", repo: "repo" };

describe("github-app repositories by name", () => {
  it("links a repository by name only once GitHub grants the installation access", async () => {
    const { fragments, test } = await buildHarness(config);
    const { callRoute, db } = fragments.githubApp;
    const access = () => callRoute("GET", "/repositories/:owner/:repo", { pathParams });
    const link = () =>
      callRoute("POST", "/repositories/:owner/:repo/link", { pathParams, body: {} });
    const unlink = () =>
      callRoute("POST", "/repositories/:owner/:repo/unlink", { pathParams, body: {} });

    try {
      expect(await access()).toMatchObject({ type: "json", data: { status: "not-installed" } });
      expect(await link()).toMatchObject({
        type: "error",
        error: { code: "REPO_NOT_REACHABLE" },
      });

      await runGithubUowCreate(db, "install", "installation", {
        id: "1",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });
      expect(await access()).toMatchObject({
        type: "json",
        data: { status: "not-granted", installation: { id: "1", status: "active" } },
      });

      await runGithubUowCreate(db, "grant", "installation_repo", {
        id: "10",
        installationId: "1",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });
      expect(await access()).toMatchObject({
        type: "json",
        data: { status: "reachable", repository: { id: "10", linked: false } },
      });

      expect(await link()).toMatchObject({
        type: "json",
        data: { repoId: "10", linkKey: "default" },
      });
      expect(await link()).toMatchObject({ type: "json", data: { repoId: "10" } });
      expect(await callRoute("GET", "/repositories/linked")).toMatchObject({
        type: "json",
        data: [{ fullName: "octo/repo", linkKeys: ["default"] }],
      });

      expect(await unlink()).toMatchObject({ type: "json", data: { status: "unlinked" } });
      expect(await unlink()).toMatchObject({ type: "json", data: { status: "not-linked" } });
      expect(await access()).toMatchObject({
        type: "json",
        data: { status: "reachable", repository: { linked: false } },
      });
    } finally {
      await test.cleanup();
    }
  });
});
