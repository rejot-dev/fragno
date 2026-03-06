import { generateKeyPairSync } from "crypto";
import { describe, expect, it } from "vitest";

import { buildHarness } from "./test-utils";

const createPrivateKey = () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
};

describe("github-app fragment dependencies", () => {
  it("registers githubApiClient as dependency and public service", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const deps = fragments.githubApp.fragment.$internal.deps as {
        githubApiClient?: {
          listInstallationRepos?: unknown;
          listPullRequests?: unknown;
          createPullRequestReview?: unknown;
          verifyWebhookSignature?: unknown;
        };
      };
      const services = fragments.githubApp.fragment.services as {
        githubApiClient?: {
          listInstallationRepos?: unknown;
          listPullRequests?: unknown;
          createPullRequestReview?: unknown;
          verifyWebhookSignature?: unknown;
        };
      };

      expect(deps.githubApiClient).toMatchObject({
        listInstallationRepos: expect.any(Function),
        listPullRequests: expect.any(Function),
        createPullRequestReview: expect.any(Function),
        verifyWebhookSignature: expect.any(Function),
      });
      expect(services.githubApiClient).toMatchObject({
        listInstallationRepos: expect.any(Function),
        listPullRequests: expect.any(Function),
        createPullRequestReview: expect.any(Function),
        verifyWebhookSignature: expect.any(Function),
      });
    } finally {
      await test.cleanup();
    }
  });
});
