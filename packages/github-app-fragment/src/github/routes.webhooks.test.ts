import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac, generateKeyPairSync } from "crypto";
import { drainDurableHooks } from "@fragno-dev/test";

import { buildHarness } from "./test-utils";

type FetchCall = {
  url: URL;
  init?: RequestInit;
};

type InstallationRow = {
  id: { valueOf: () => string } | string;
  status?: string | null;
  accountLogin?: string | null;
  lastWebhookAt?: Date | null;
};

type InstallationRepoRow = {
  id: { valueOf: () => string } | string;
  installationId?: string | null;
  removedAt?: Date | null;
  fullName?: string | null;
  isFork?: boolean | null;
  defaultBranch?: string | null;
};

type RepoLinkRow = {
  id: { valueOf: () => string } | string;
  repoId?: string | null;
};

const toExternalId = (value: unknown) => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return `${value}`;
  }
  if (typeof value === "object" && value && "valueOf" in value) {
    const valueOf = (value as { valueOf?: () => unknown }).valueOf;
    if (typeof valueOf === "function") {
      const result = valueOf.call(value);
      if (typeof result === "string") {
        return result;
      }
    }
  }
  return "";
};

const createPrivateKey = () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
};

const createSignature = (secret: string, payload: string) => {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
};

const assertErrorResponse = async (response: Response, status: number, code: string) => {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { code?: string };
  expect(body.code).toBe(code);
};

const createWebhookRequest = (body: string, headers: Record<string, string>) => {
  return new Request("https://example.com/api/github-app-fragment/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
};

const getHandler = (fragment: unknown) => {
  return (fragment as { fragment: { handler: (req: Request) => Promise<Response> } }).fragment
    .handler;
};

const createFetchMock = (options: {
  installationId: string;
  repositories: Array<Record<string, unknown>>;
}) => {
  const calls: FetchCall[] = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);

    calls.push({ url, init });

    if (url.pathname === `/app/installations/${options.installationId}/access_tokens`) {
      return new Response(
        JSON.stringify({
          token: "installation-token",
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    if (url.pathname === "/installation/repositories") {
      return new Response(JSON.stringify({ repositories: options.repositories }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ message: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };

  return Object.assign(fetchMock, { calls });
};

describe("github-app webhooks", () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    const originalFetch = globalThis.fetch;
    restoreFetch = () => {
      globalThis.fetch = originalFetch;
    };
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  it("rejects invalid signatures", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const payload = JSON.stringify({
        action: "created",
        installation: { id: 123, account: { id: 1, login: "octo", type: "User" } },
      });

      const response = await getHandler(fragments.githubApp)(
        createWebhookRequest(payload, {
          "x-hub-signature-256": "sha256=bad",
          "x-github-delivery": "delivery-1",
          "x-github-event": "installation",
        }),
      );

      expect(response.status).toBe(401);
    } finally {
      await test.cleanup();
    }
  });

  it("rejects missing signature headers", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const payload = JSON.stringify({
        action: "created",
        installation: { id: 123 },
      });

      const response = await getHandler(fragments.githubApp)(
        createWebhookRequest(payload, {
          "x-github-delivery": "delivery-missing-signature",
          "x-github-event": "installation",
        }),
      );

      await assertErrorResponse(response, 401, "WEBHOOK_SIGNATURE_INVALID");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects missing delivery ids", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const payload = JSON.stringify({
        action: "created",
        installation: { id: 123 },
      });
      const signature = createSignature("secret", payload);

      const response = await getHandler(fragments.githubApp)(
        createWebhookRequest(payload, {
          "x-hub-signature-256": signature,
          "x-github-event": "installation",
        }),
      );

      await assertErrorResponse(response, 400, "WEBHOOK_DELIVERY_MISSING");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects missing webhook event types", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const payload = JSON.stringify({
        action: "created",
        installation: { id: 123 },
      });
      const signature = createSignature("secret", payload);

      const response = await getHandler(fragments.githubApp)(
        createWebhookRequest(payload, {
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-missing-event",
        }),
      );

      await assertErrorResponse(response, 400, "WEBHOOK_PAYLOAD_INVALID");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects invalid JSON payloads", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const payload = "{ invalid-json";
      const signature = createSignature("secret", payload);

      const response = await getHandler(fragments.githubApp)(
        createWebhookRequest(payload, {
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-invalid-json",
          "x-github-event": "installation",
        }),
      );

      await assertErrorResponse(response, 400, "WEBHOOK_PAYLOAD_INVALID");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects non-object webhook payloads", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const payload = JSON.stringify(["not-an-object"]);
      const signature = createSignature("secret", payload);

      const response = await getHandler(fragments.githubApp)(
        createWebhookRequest(payload, {
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-non-object",
          "x-github-event": "installation",
        }),
      );

      await assertErrorResponse(response, 400, "WEBHOOK_PAYLOAD_INVALID");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects payloads missing installation ids", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const payload = JSON.stringify({ action: "created" });
      const signature = createSignature("secret", payload);

      const response = await getHandler(fragments.githubApp)(
        createWebhookRequest(payload, {
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-missing-installation",
          "x-github-event": "installation",
        }),
      );

      await assertErrorResponse(response, 400, "WEBHOOK_PAYLOAD_INVALID");
    } finally {
      await test.cleanup();
    }
  });

  it("processes installation events via durable hooks", async () => {
    const installationId = "123";

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const payload = JSON.stringify({
        action: "created",
        installation: {
          id: Number(installationId),
          account: { id: 1, login: "octo", type: "User" },
          permissions: { contents: "read" },
          events: ["installation"],
        },
        repositories: [
          {
            id: 101,
            name: "new-repo",
            full_name: "octo/new-repo",
            private: false,
            node_id: "R_abc",
          },
        ],
      });

      const signature = createSignature("secret", payload);

      const response = await getHandler(fragments.githubApp)(
        createWebhookRequest(payload, {
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-2",
          "x-github-event": "installation",
        }),
      );

      expect(response.status).toBe(204);

      await drainDurableHooks(fragments.githubApp.fragment);

      const installations = (await fragments.githubApp.db.find(
        "installation",
      )) as InstallationRow[];
      expect(installations).toHaveLength(1);
      expect(toExternalId(installations[0]?.id)).toBe(installationId);
      expect(installations[0]?.status).toBe("active");
      expect(installations[0]?.accountLogin).toBe("octo");
      expect(installations[0]?.lastWebhookAt).toBeInstanceOf(Date);

      const repos = (await fragments.githubApp.db.find(
        "installation_repo",
      )) as InstallationRepoRow[];
      expect(repos).toHaveLength(1);
      expect(repos[0]?.fullName).toBe("octo/new-repo");

      const duplicate = await getHandler(fragments.githubApp)(
        createWebhookRequest(payload, {
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-2",
          "x-github-event": "installation",
        }),
      );

      expect(duplicate.status).toBe(204);

      await drainDurableHooks(fragments.githubApp.fragment);

      const reposAfter = (await fragments.githubApp.db.find(
        "installation_repo",
      )) as InstallationRepoRow[];
      expect(reposAfter).toHaveLength(1);
    } finally {
      await test.cleanup();
    }
  });

  it("handles installation created with no repositories", async () => {
    const installationId = "321";

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const payload = JSON.stringify({
        action: "created",
        installation: {
          id: Number(installationId),
          account: { id: 2, login: "octo-empty", type: "User" },
          permissions: { contents: "read" },
          events: ["installation"],
        },
      });

      const signature = createSignature("secret", payload);

      const response = await getHandler(fragments.githubApp)(
        createWebhookRequest(payload, {
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-no-repos",
          "x-github-event": "installation",
        }),
      );

      expect(response.status).toBe(204);

      await drainDurableHooks(fragments.githubApp.fragment);

      const installations = (await fragments.githubApp.db.find(
        "installation",
      )) as InstallationRow[];
      expect(installations).toHaveLength(1);
      expect(toExternalId(installations[0]?.id)).toBe(installationId);
      expect(installations[0]?.status).toBe("active");

      const repos = (await fragments.githubApp.db.find(
        "installation_repo",
      )) as InstallationRepoRow[];
      expect(repos).toHaveLength(0);
    } finally {
      await test.cleanup();
    }
  });

  it("uses installation webhook repositories payload when available", async () => {
    const installationId = "789";
    const payloadRepositories = [
      {
        id: 201,
        node_id: "R_kgDOA",
        name: "payload-repo",
        full_name: "octo/payload-repo",
        private: false,
      },
    ];

    const fetchMock = createFetchMock({
      installationId,
      repositories: [
        {
          id: 999,
          name: "api-repo",
          full_name: "octo/api-repo",
          private: false,
          fork: false,
          default_branch: "main",
          owner: { login: "octo" },
        },
      ],
    });
    globalThis.fetch = fetchMock;

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const payload = JSON.stringify({
        action: "created",
        installation: {
          id: Number(installationId),
          account: { id: 1, login: "octo", type: "User" },
          permissions: { contents: "read" },
          events: ["installation"],
        },
        repositories: payloadRepositories,
      });

      const signature = createSignature("secret", payload);

      const response = await getHandler(fragments.githubApp)(
        createWebhookRequest(payload, {
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-uses-payload-repos",
          "x-github-event": "installation",
        }),
      );

      expect(response.status).toBe(204);

      await drainDurableHooks(fragments.githubApp.fragment);

      const repos = (await fragments.githubApp.db.find(
        "installation_repo",
      )) as InstallationRepoRow[];
      expect(repos).toHaveLength(1);
      expect(repos[0]?.fullName).toBe("octo/payload-repo");
      expect(toExternalId(repos[0]?.id)).toBe("201");
      expect(repos[0]?.isFork).toBeNull();
      expect(repos[0]?.defaultBranch).toBeNull();

      const installationRepoCalls = fetchMock.calls.filter(
        (call) => call.url.pathname === "/installation/repositories",
      );
      expect(installationRepoCalls).toHaveLength(0);
    } finally {
      await test.cleanup();
    }
  });

  it("does not overwrite fork/default branch when installation payload omits them", async () => {
    const installationId = "790";

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      await fragments.githubApp.db.create("installation", {
        id: installationId,
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await fragments.githubApp.db.create("installation_repo", {
        id: "201",
        installationId,
        ownerLogin: "octo",
        name: "payload-repo",
        fullName: "octo/payload-repo",
        isPrivate: false,
        isFork: true,
        defaultBranch: "develop",
        removedAt: null,
      });

      const payload = JSON.stringify({
        action: "new_permissions_accepted",
        installation: {
          id: Number(installationId),
          account: { id: 1, login: "octo", type: "User" },
          permissions: { contents: "read" },
          events: ["installation"],
        },
        repositories: [
          {
            id: 201,
            node_id: "R_kgDOA",
            name: "payload-repo",
            full_name: "octo/payload-repo",
            private: false,
          },
        ],
      });

      const signature = createSignature("secret", payload);

      const response = await getHandler(fragments.githubApp)(
        createWebhookRequest(payload, {
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-preserve-fork-default-branch",
          "x-github-event": "installation",
        }),
      );

      expect(response.status).toBe(204);

      await drainDurableHooks(fragments.githubApp.fragment);

      const repos = (await fragments.githubApp.db.find(
        "installation_repo",
      )) as InstallationRepoRow[];
      expect(repos).toHaveLength(1);
      expect(repos[0]?.isFork).toBe(true);
      expect(repos[0]?.defaultBranch).toBe("develop");
    } finally {
      await test.cleanup();
    }
  });

  it("handles installation_repositories updates", async () => {
    const installationId = "456";

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      await fragments.githubApp.db.create("installation", {
        id: installationId,
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await fragments.githubApp.db.create("installation_repo", {
        id: "10",
        installationId,
        ownerLogin: "octo",
        name: "removed-repo",
        fullName: "octo/removed-repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await fragments.githubApp.db.create("repo_link", {
        repoId: "10",
        linkKey: "default",
      });

      const payload = JSON.stringify({
        action: "added",
        installation: {
          id: Number(installationId),
          account: { id: 1, login: "octo", type: "User" },
          permissions: { contents: "read" },
          events: ["installation_repositories"],
        },
        repositories_added: [
          {
            id: 20,
            name: "added-repo",
            full_name: "octo/added-repo",
            private: false,
            fork: false,
            default_branch: "main",
            owner: { login: "octo" },
          },
        ],
        repositories_removed: [
          {
            id: 10,
            name: "removed-repo",
            full_name: "octo/removed-repo",
            private: false,
            fork: false,
            default_branch: "main",
            owner: { login: "octo" },
          },
        ],
      });

      const signature = createSignature("secret", payload);

      const response = await getHandler(fragments.githubApp)(
        createWebhookRequest(payload, {
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-3",
          "x-github-event": "installation_repositories",
        }),
      );

      expect(response.status).toBe(204);

      await drainDurableHooks(fragments.githubApp.fragment);

      const repos = (await fragments.githubApp.db.find(
        "installation_repo",
      )) as InstallationRepoRow[];
      const byId = new Map(repos.map((repo) => [toExternalId(repo.id), repo]));

      expect(byId.get("20")?.removedAt).toBeNull();
      expect(byId.get("20")?.fullName).toBe("octo/added-repo");
      expect(byId.get("10")?.removedAt).toBeInstanceOf(Date);

      const links = (await fragments.githubApp.db.find("repo_link")) as RepoLinkRow[];
      expect(links).toHaveLength(0);
    } finally {
      await test.cleanup();
    }
  });
});
