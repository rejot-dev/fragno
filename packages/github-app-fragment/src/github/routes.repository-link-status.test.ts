import { describe, expect, it, vi, assert } from "vitest";

import { createHmac } from "crypto";

import { drainDurableHooks } from "@fragno-dev/test";

import { buildHarness, runGithubUowCreate } from "./test-utils";

const webhookSecret = "secret";
const pathParams = { owner: "octo", repo: "repo" };
const installation = {
  id: 1,
  account: { id: 1, login: "octo", type: "User" },
  permissions: { contents: "read" },
  events: [],
};
const repository = {
  id: 10,
  name: "repo",
  full_name: "octo/repo",
  private: false,
  owner: { login: "octo" },
};

describe("github-app repository link status", () => {
  it("reports links as they are made, follow their installation, and lose their repository", async () => {
    const onRepositoryLinkStatusChanged = vi.fn();
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: "test-key",
      webhookSecret,
      onRepositoryLinkStatusChanged,
    });
    const { callRoute, db, fragment } = fragments.githubApp;
    const link = () =>
      callRoute("POST", "/repositories/:owner/:repo/link", { pathParams, body: {} });
    const unlink = () =>
      callRoute("POST", "/repositories/:owner/:repo/unlink", { pathParams, body: {} });
    let delivery = 0;
    const deliver = async (event: string, payload: Record<string, unknown>) => {
      const body = JSON.stringify(payload);
      delivery += 1;
      const response = await fragment.handler(
        new Request("https://example.com/api/github-app-fragment/webhooks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
            "x-github-delivery": `delivery-${delivery}`,
            "x-github-event": event,
          },
          body,
        }),
      );
      assert(response.status === 204);
      // Webhook hooks can run concurrently; each delivery here depends on the previous one.
      await drainDurableHooks(fragment);
    };
    const statuses = async () => {
      await drainDurableHooks(fragment);
      return onRepositoryLinkStatusChanged.mock.calls.map(([payload]) => payload.status);
    };

    try {
      await runGithubUowCreate(db, "install", "installation", {
        id: "1",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
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

      await link();
      await link();
      await unlink();
      await link();
      expect(await statuses()).toEqual(["active", "unlinked", "active"]);
      expect(onRepositoryLinkStatusChanged.mock.calls[0][0]).toEqual({
        linkKey: "default",
        repositoryId: "10",
        fullName: "octo/repo",
        status: "active",
      });

      await deliver("installation", { action: "suspend", installation });
      await deliver("installation", { action: "unsuspend", installation });
      await deliver("installation_repositories", {
        action: "removed",
        installation,
        repositories_added: [],
        repositories_removed: [repository],
      });
      expect(await statuses()).toEqual([
        "active",
        "unlinked",
        "active",
        "inactive",
        "active",
        "unlinked",
      ]);
    } finally {
      await test.cleanup();
    }
  });
});
