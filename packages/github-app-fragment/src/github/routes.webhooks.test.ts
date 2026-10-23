import { describe, expect, it, vi, assert } from "vitest";

import { createHmac, generateKeyPairSync } from "crypto";

import { internalSchema } from "@fragno-dev/db";
import { drainDurableHooks } from "@fragno-dev/test";

import { githubAppSchema } from "../schema";
import {
  buildHarness,
  createFakeGitHub,
  type FakeGitHubInstallation,
  testPrivateKeyPem,
} from "./test-utils";
import type { GitHubAppFragmentConfig } from "./types";

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
  return privateKey.export({ type: "pkcs1", format: "pem" });
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

describe("github-app webhooks", () => {
  it("rejects invalid signatures", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
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

      assert(response.status === 401);
    } finally {
      await test.cleanup();
    }
  });

  it("rejects missing signature headers", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
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
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
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
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
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
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
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
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
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
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
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

  const octo = { id: 1, login: "octo", type: "User" };
  const installationPayload = (id: number) => ({
    id,
    account: octo,
    permissions: { contents: "read" },
    events: ["installation"],
  });
  const repository = (id: number, name: string) => ({
    id,
    name,
    full_name: `octo/${name}`,
    private: false,
    owner: { login: "octo" },
  });

  const retentionMs = 60_000;

  /** A harness whose GitHub answers from `installations`, delivering signed webhooks to it. */
  async function webhookScenario(
    installations: Map<string, FakeGitHubInstallation>,
    webhook?: GitHubAppFragmentConfig["webhook"],
  ) {
    const harness = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: testPrivateKeyPem,
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: retentionMs,
      fetch: createFakeGitHub(installations),
      webhook,
    });
    let delivery = 0;
    /** Accepts a delivery without running its hook. */
    async function receive(event: string, action: string, payload: Record<string, unknown>) {
      delivery += 1;
      const body = JSON.stringify({ action, ...payload });
      const response = await getHandler(harness.fragments.githubApp)(
        createWebhookRequest(body, {
          "x-hub-signature-256": createSignature("secret", body),
          "x-github-delivery": `delivery-${delivery}`,
          "x-github-event": event,
        }),
      );
      assert(response.status === 204);
    }
    return {
      ...harness,
      receive,
      async deliver(event: string, action: string, payload: Record<string, unknown>) {
        await receive(event, action, payload);
        await drainDurableHooks(harness.fragments.githubApp.fragment);
      },
      async hooks() {
        const [rows] = await harness.fragments.githubApp.db
          .createUnitOfWork("read-hooks")
          .forSchema(internalSchema)
          .find("fragno_hooks", (b) => b.whereIndex("primary"))
          .executeRetrieve();
        return rows;
      },
      async readDelivery(deliveryId: string) {
        return await getHandler(harness.fragments.githubApp)(
          new Request(
            `https://example.com/api/github-app-fragment/webhooks/deliveries/${deliveryId}`,
          ),
        );
      },
      async installation(installationId: string) {
        const [rows] = await harness.fragments.githubApp.db
          .createUnitOfWork("read")
          .forSchema(githubAppSchema)
          .find("installation", (b) => b.whereIndex("primary"))
          .executeRetrieve();
        return rows.find((row) => toExternalId(row.id) === installationId);
      },
      async presentRepositories() {
        const [rows] = await harness.fragments.githubApp.db
          .createUnitOfWork("read")
          .forSchema(githubAppSchema)
          .find("installation_repo", (b) => b.whereIndex("primary"))
          .executeRetrieve();
        return rows
          .filter((row) => row.removedAt === null)
          .map((row) => row.fullName)
          .sort();
      },
    };
  }

  it("keeps deliveries until their retention after processing passes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const onPush = vi.fn<(event: { id: string }) => Promise<void>>(async () => {});
    const scenario = await webhookScenario(new Map(), (register) => register("push", onPush));
    try {
      const push = { installation: { id: 123 }, ref: "refs/heads/main" };
      await scenario.receive("push", "", push);
      // A delivery whose hook has not run is kept however long ago it arrived.
      vi.setSystemTime(start + 2 * retentionMs);
      await scenario.receive("push", "", push);
      const pending = await scenario.readDelivery("delivery-1");
      assert(pending.status === 200);
      expect(await pending.json()).toEqual({
        deliveryId: "delivery-1",
        event: "push",
        action: "",
        installationId: "123",
        receivedAt: "2026-01-01T00:00:00.000Z",
        payload: { action: "", ...push },
      });

      await drainDurableHooks(scenario.fragments.githubApp.fragment);
      expect(onPush.mock.calls.map(([event]) => event.id).sort()).toEqual([
        "delivery-1",
        "delivery-2",
      ]);

      vi.setSystemTime(start + 3 * retentionMs + 1);
      await scenario.deliver("push", "", push);
      for (const deliveryId of ["delivery-1", "delivery-2"]) {
        await assertErrorResponse(
          await scenario.readDelivery(deliveryId),
          404,
          "WEBHOOK_DELIVERY_NOT_FOUND",
        );
      }
      assert((await scenario.readDelivery("delivery-3")).status === 200);
    } finally {
      vi.useRealTimers();
      await scenario.test.cleanup();
    }
  });

  it("a replayed hook whose completion was lost neither reruns nor fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const onPush = vi.fn<(event: { id: string }) => Promise<void>>(async () => {});
    const scenario = await webhookScenario(new Map(), (register) => register("push", onPush));
    // The handler committed, but the processor stopped before settling the hook, which stale
    // recovery later replays.
    async function loseCompletion() {
      const [hook] = await scenario.hooks();
      assert(hook);
      const uow = scenario.fragments.githubApp.db
        .createUnitOfWork("lose-completion")
        .forSchema(internalSchema);
      uow.update("fragno_hooks", hook.id, (b) =>
        b.set({ status: "processing", lastAttemptAt: new Date(start) }),
      );
      assert((await uow.executeMutations()).success);
    }
    try {
      const push = { installation: { id: 123 }, ref: "refs/heads/main" };
      await scenario.deliver("push", "", push);
      await loseCompletion();
      vi.setSystemTime(start + 11 * 60_000);
      await drainDurableHooks(scenario.fragments.githubApp.fragment);
      expect(onPush).toHaveBeenCalledOnce();

      // A later delivery deletes the processed one before the replay finds it.
      await loseCompletion();
      await scenario.receive("push", "", push);
      await assertErrorResponse(
        await scenario.readDelivery("delivery-1"),
        404,
        "WEBHOOK_DELIVERY_NOT_FOUND",
      );
      await drainDurableHooks(scenario.fragments.githubApp.fragment);

      expect(onPush.mock.calls.map(([event]) => event.id).sort()).toEqual([
        "delivery-1",
        "delivery-2",
      ]);
      expect(await scenario.hooks()).toMatchObject([
        { hookName: "processWebhook", status: "completed", attempts: 0 },
        { hookName: "processWebhook", status: "completed", attempts: 0 },
      ]);
    } finally {
      vi.useRealTimers();
      await scenario.test.cleanup();
    }
  });

  it("rejects a retention that is not a positive whole number of milliseconds", async () => {
    for (const webhookDeliveryRetentionMs of [0, -1, 1.5, Number.NaN]) {
      await expect(
        buildHarness({
          appId: "42",
          appSlug: "test-app",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          callbackUrl: "https://example.com/github/callback",
          privateKeyPem: testPrivateKeyPem,
          webhookSecret: "secret",
          webhookDeliveryRetentionMs,
        }),
      ).rejects.toThrow("webhookDeliveryRetentionMs must be a positive whole number");
    }
  });

  it("installation deliveries store the installation GitHub reports, not their payload", async () => {
    const github: FakeGitHubInstallation = {
      account: octo,
      suspended: false,
      repositories: [repository(101, "api"), repository(102, "web")],
    };
    const scenario = await webhookScenario(new Map([["123", github]]));
    try {
      await scenario.deliver("installation", "created", {
        installation: installationPayload(123),
        repositories: [repository(103, "stale")],
      });
      const installation = await scenario.installation("123");
      expect(installation).toMatchObject({ status: "active", accountLogin: "octo" });
      expect(installation?.lastWebhookAt).toBeInstanceOf(Date);
      expect(await scenario.presentRepositories()).toEqual(["octo/api", "octo/web"]);

      github.repositories = [repository(101, "api")];
      await scenario.deliver("installation_repositories", "removed", {
        installation: installationPayload(123),
        repositories_added: [],
        repositories_removed: [repository(102, "web")],
      });
      expect(await scenario.presentRepositories()).toEqual(["octo/api"]);
    } finally {
      await scenario.test.cleanup();
    }
  });

  it("deliveries arriving out of order cannot roll back GitHub's current state", async () => {
    const github: FakeGitHubInstallation = {
      account: octo,
      suspended: false,
      repositories: [repository(101, "api")],
    };
    const scenario = await webhookScenario(new Map([["123", github]]));
    try {
      await scenario.deliver("installation", "created", {
        installation: installationPayload(123),
      });
      // GitHub suspended and restored the installation, then removed and re-added the repository.
      await scenario.deliver("installation", "suspend", {
        installation: installationPayload(123),
      });
      await scenario.deliver("installation_repositories", "removed", {
        installation: installationPayload(123),
        repositories_added: [],
        repositories_removed: [repository(101, "api")],
      });
      expect(await scenario.installation("123")).toMatchObject({ status: "active" });
      expect(await scenario.presentRepositories()).toEqual(["octo/api"]);

      // A suspended installation issues no tokens, so its repositories keep their last state.
      github.suspended = true;
      github.repositories = [];
      await scenario.deliver("installation", "unsuspend", {
        installation: installationPayload(123),
      });
      expect(await scenario.installation("123")).toMatchObject({ status: "suspended" });
      expect(await scenario.presentRepositories()).toEqual(["octo/api"]);
    } finally {
      await scenario.test.cleanup();
    }
  });

  it("an installation GitHub deleted is marked deleted and still reaches configured handlers", async () => {
    const onInstallationDeleted = vi.fn<
      (payload: unknown, idempotencyKey: string) => Promise<void>
    >(async () => {});
    const onInstallation = vi.fn<(payload: unknown, idempotencyKey: string) => Promise<void>>(
      async () => {},
    );
    const installations = new Map<string, FakeGitHubInstallation>([
      ["654", { account: octo, suspended: false, repositories: [] }],
    ]);
    const scenario = await webhookScenario(installations, (register) => {
      register("installation.deleted", onInstallationDeleted);
      register("installation", onInstallation);
    });
    try {
      await scenario.deliver("installation", "created", {
        installation: installationPayload(654),
      });
      installations.delete("654");
      await scenario.deliver("installation", "deleted", {
        installation: installationPayload(654),
      });

      expect(await scenario.installation("654")).toMatchObject({ status: "deleted" });
      expect(onInstallationDeleted).toHaveBeenCalledTimes(1);
      expect(onInstallationDeleted).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "delivery-2",
          name: "installation",
          payload: expect.objectContaining({
            action: "deleted",
            installation: expect.objectContaining({ id: 654 }),
          }),
        }),
        expect.any(String),
        expect.objectContaining({
          deliveryId: "delivery-2",
          event: "installation",
          action: "deleted",
          installationId: "654",
        }),
      );
      expect(onInstallation).toHaveBeenCalledTimes(2);
    } finally {
      await scenario.test.cleanup();
    }
  });
});
