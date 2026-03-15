import { describe, expect, it } from "vitest";

import { generateKeyPairSync } from "crypto";

import { buildHarness } from "./test-utils";

const createPrivateKey = () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
};

describe("github-app fragment dependencies", () => {
  it("registers githubApiClient and app as dependency/public services", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const deps = fragments.githubApp.fragment.$internal.deps as {
        githubApiClient?: {
          app?: {
            octokit?: unknown;
            webhooks?: unknown;
          };
          getInstallation?: unknown;
          listInstallationRepos?: unknown;
          verifyWebhookSignature?: unknown;
        };
      };
      const services = fragments.githubApp.fragment.services as {
        app?: {
          octokit?: unknown;
          webhooks?: unknown;
        };
        githubApiClient?: {
          app?: {
            octokit?: unknown;
            webhooks?: unknown;
          };
          getInstallation?: unknown;
          listInstallationRepos?: unknown;
          verifyWebhookSignature?: unknown;
        };
      };

      expect(deps.githubApiClient).toMatchObject({
        app: expect.objectContaining({
          octokit: expect.objectContaining({ request: expect.any(Function) }),
          webhooks: expect.objectContaining({ verify: expect.any(Function) }),
        }),
        getInstallation: expect.any(Function),
        listInstallationRepos: expect.any(Function),
        verifyWebhookSignature: expect.any(Function),
      });
      expect(services.app).toMatchObject({
        octokit: expect.objectContaining({ request: expect.any(Function) }),
        webhooks: expect.objectContaining({ verify: expect.any(Function) }),
      });
      expect(services.githubApiClient).toMatchObject({
        app: expect.objectContaining({
          octokit: expect.objectContaining({ request: expect.any(Function) }),
          webhooks: expect.objectContaining({ verify: expect.any(Function) }),
        }),
        getInstallation: expect.any(Function),
        listInstallationRepos: expect.any(Function),
        verifyWebhookSignature: expect.any(Function),
      });
    } finally {
      await test.cleanup();
    }
  });
});
