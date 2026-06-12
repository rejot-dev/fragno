import { afterAll, beforeAll, beforeEach, describe, expect, test, vi, assert } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { createCloudflareApiClient } from "./cloudflare-api";
import { cloudflareDeployRequestSchema } from "./contracts";
import { cloudflareFragmentDefinition, type CloudflareFragmentConfig } from "./definition";
import { buildCloudflareAppTag, buildCloudflareDeploymentTag } from "./deployment-tag";
import { cloudflareRoutesFactory } from "./routes";
import { cloudflareSchema } from "./schema";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const jsonHeaders = {
  "content-type": "application/json",
};

const createSuccessResponse = (result: unknown, status = 200) =>
  new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result,
    }),
    {
      status,
      headers: jsonHeaders,
    },
  );

const createErrorResponse = (
  status: number,
  errors: Array<{
    code: number | string;
    message: string;
  }>,
) =>
  new Response(
    JSON.stringify({
      success: false,
      errors,
      messages: [],
      result: null,
    }),
    {
      status,
      headers: jsonHeaders,
    },
  );

const fetchMock = vi.fn<typeof fetch>();
const cloudflare = createCloudflareApiClient({
  apiToken: "cf_test_token",
  fetchImplementation: fetchMock,
});
const config: CloudflareFragmentConfig = {
  accountId: "acct_test",
  dispatcher: {
    binding: { get: vi.fn() },
    namespace: "dispatch-prod",
  },
  compatibilityDate: "2026-03-10",
  compatibilityFlags: ["nodejs_compat"],
  scriptNamePrefix: "fragno",
  scriptNameSuffix: "worker",
  deploymentTagPrefix: "fragno-deployment",
  cloudflare,
};
const invalidDispatcherConfig: CloudflareFragmentConfig = {
  accountId: "acct_test",
  // @ts-expect-error dispatcher bindings must be wrapped in a namespace descriptor
  dispatcher: { get: vi.fn() },
  compatibilityDate: "2026-03-10",
  cloudflare,
};
void invalidDispatcherConfig;

const buildCloudflareTestSetup = async () => {
  return await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "cloudflare",
      instantiate(cloudflareFragmentDefinition)
        .withConfig(config)
        .withRoutes([cloudflareRoutesFactory]),
    )
    .build();
};

type CloudflareTestSetup = Awaited<ReturnType<typeof buildCloudflareTestSetup>>;

let fragment!: CloudflareTestSetup["fragments"]["cloudflare"]["fragment"];
let db!: CloudflareTestSetup["fragments"]["cloudflare"]["db"];
let testContext!: CloudflareTestSetup["test"];

describe("cloudflare-fragment", () => {
  beforeAll(async () => {
    const setup = await buildCloudflareTestSetup();
    fragment = setup.fragments.cloudflare.fragment;
    db = setup.fragments.cloudflare.db;
    testContext = setup.test;
  });

  const getApp = async (id: string) =>
    (async () => {
      const uow = db
        .createUnitOfWork("read")
        .forSchema(cloudflareSchema)
        .findFirst("app", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id)));
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
  const getDeployment = async (id: string) =>
    (async () => {
      const uow = db
        .createUnitOfWork("read")
        .forSchema(cloudflareSchema)
        .findFirst("deployment", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id)));
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
  const getFetchHeaders = (index: number) =>
    new Headers((fetchMock.mock.calls[index]?.[1]?.headers ?? {}) as HeadersInit);

  beforeEach(async () => {
    await testContext.resetDatabase();
    fetchMock.mockReset();
  });

  afterAll(async () => {
    await testContext.cleanup();
  });

  test("queues a deployment, creates an app record, and exposes the SDK client as a service", async () => {
    const response = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('ok'); } };",
        },
      },
    });

    assert(response.type === "json");
    if (response.type !== "json") {
      return;
    }

    expect(fragment.services.cloudflare.getClient()).toBe(cloudflare);
    expect(response.data).toMatchObject({
      appId: "tenant-app",
      status: "queued",
      format: "esmodule",
      scriptName: "fragno-tenant-app-worker",
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
    });
    expect(response.data.queuedAt).toBeTypeOf("string");
    expect(response.data.createdAt).toBeTypeOf("string");
    expect(response.data.updatedAt).toBeTypeOf("string");

    const app = await getApp("tenant-app");
    expect(app).toBeTruthy();
    assert(app?.scriptName === "fragno-tenant-app-worker");

    const appState = await fragment.callRoute("GET", "/apps/:appId", {
      pathParams: { appId: "tenant-app" },
    });

    assert(appState.type === "json");
    if (appState.type !== "json") {
      return;
    }

    expect(appState.data.latestDeployment?.id).toBe(response.data.id);
    assert(appState.data.latestDeployment?.status === "queued");
    expect(appState.data.liveDeployment).toBeNull();
    expect(appState.data.liveDeploymentError).toBeNull();
    expect(appState.data.deployments.map((deployment) => deployment.id)).toEqual([
      response.data.id,
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("processes queued deployments through the durable hook", async () => {
    fetchMock.mockResolvedValueOnce(
      createSuccessResponse({
        id: "worker-script",
        startup_time_ms: 0,
        etag: "etag_123",
        modified_on: "2026-03-10T12:00:00.000Z",
      }),
    );

    const queued = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('ok'); } };",
        },
      },
    });

    assert(queued.type === "json");
    if (queued.type !== "json") {
      return;
    }

    await drainDurableHooks(fragment);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/workers/dispatch/namespaces/dispatch-prod/scripts/fragno-tenant-app-worker",
    );
    expect(getFetchHeaders(0).get("if-match")).toBeNull();

    const deployment = await getDeployment(queued.data.id);
    assert(deployment?.status === "succeeded");
    assert(deployment?.cloudflareEtag === "etag_123");
    assert(deployment?.attemptCount === 1);

    const app = await getApp("tenant-app");
    expect(app?.liveDeploymentId).toBe(queued.data.id);
    assert(app?.liveCloudflareEtag === "etag_123");

    const detail = await fragment.callRoute("GET", "/deployments/:deploymentId", {
      pathParams: { deploymentId: queued.data.id },
    });

    assert(detail.type === "json");
    if (detail.type !== "json") {
      return;
    }

    assert(detail.data.status === "succeeded");
    assert(
      detail.data.sourceCode === "export default { async fetch() { return new Response('ok'); } };",
    );
    expect(detail.data.startedAt).toBeTypeOf("string");
    expect(detail.data.completedAt).toBeTypeOf("string");
    expect(detail.data.createdAt).toBeTypeOf("string");
    expect(detail.data.updatedAt).toBeTypeOf("string");
    expect(detail.data.cloudflare).toEqual({
      etag: "etag_123",
      modifiedOn: "2026-03-10T12:00:00.000Z",
    });
  });

  test("returns the currently live deployment separately from the latest recorded deployment", async () => {
    fetchMock.mockResolvedValueOnce(
      createSuccessResponse({
        id: "worker-script",
        startup_time_ms: 0,
        etag: "etag_123",
        modified_on: "2026-03-10T12:00:00.000Z",
      }),
    );

    const firstDeployment = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('first'); } };",
        },
      },
    });

    assert(firstDeployment.type === "json");
    if (firstDeployment.type !== "json") {
      return;
    }

    await drainDurableHooks(fragment);

    const secondDeployment = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('second'); } };",
        },
      },
    });

    assert(secondDeployment.type === "json");
    if (secondDeployment.type !== "json") {
      return;
    }

    const appState = await fragment.callRoute("GET", "/apps/:appId", {
      pathParams: { appId: "tenant-app" },
    });

    assert(appState.type === "json");
    if (appState.type !== "json") {
      return;
    }

    expect(appState.data.latestDeployment?.id).toBe(secondDeployment.data.id);
    assert(appState.data.latestDeployment?.status === "queued");
    expect(appState.data.liveDeployment?.id).toBe(firstDeployment.data.id);
    assert(appState.data.liveDeployment?.status === "succeeded");
    expect(appState.data.liveDeploymentError).toBeNull();
    expect(appState.data.deployments.map((deployment) => deployment.id)).toEqual([
      secondDeployment.data.id,
      firstDeployment.data.id,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("lets a later deployment succeed after an intermediate upload failure", async () => {
    fetchMock
      .mockResolvedValueOnce(
        createSuccessResponse({
          id: "worker-script",
          startup_time_ms: 0,
          etag: "etag_1",
          modified_on: "2026-03-10T12:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        createErrorResponse(403, [{ code: 1001, message: "Invalid API token" }]),
      )
      .mockResolvedValueOnce(
        createSuccessResponse({
          id: "worker-script",
          startup_time_ms: 0,
          etag: "etag_3",
          modified_on: "2026-03-10T12:02:00.000Z",
        }),
      );

    const firstDeployment = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('first'); } };",
        },
      },
    });

    assert(firstDeployment.type === "json");
    if (firstDeployment.type !== "json") {
      return;
    }

    await drainDurableHooks(fragment);

    const secondDeployment = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('second'); } };",
        },
      },
    });

    assert(secondDeployment.type === "json");
    if (secondDeployment.type !== "json") {
      return;
    }

    await drainDurableHooks(fragment);

    const thirdDeployment = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('third'); } };",
        },
      },
    });

    assert(thirdDeployment.type === "json");
    if (thirdDeployment.type !== "json") {
      return;
    }

    await drainDurableHooks(fragment);

    const second = await getDeployment(secondDeployment.data.id);
    const third = await getDeployment(thirdDeployment.data.id);
    const app = await getApp("tenant-app");

    assert(second?.status === "failed");
    assert(second?.attemptCount === 1);
    assert(second?.errorCode === "1001");
    assert(second?.errorMessage === "Invalid API token");
    assert(third?.status === "succeeded");
    assert(third?.cloudflareEtag === "etag_3");
    expect(app?.liveDeploymentId).toBe(thirdDeployment.data.id);
    assert(app?.liveCloudflareEtag === "etag_3");
    assert(getFetchHeaders(2).get("if-match") === "etag_1");
  });

  test("uses Cloudflare etag CAS to prevent queued updates from rolling back the winner", async () => {
    fetchMock.mockResolvedValueOnce(
      createSuccessResponse({
        id: "worker-script",
        startup_time_ms: 0,
        etag: "etag_1",
        modified_on: "2026-03-10T12:00:00.000Z",
      }),
    );

    const firstDeployment = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('first'); } };",
        },
      },
    });

    assert(firstDeployment.type === "json");
    if (firstDeployment.type !== "json") {
      return;
    }

    await drainDurableHooks(fragment);

    const secondDeployment = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('second'); } };",
        },
      },
    });
    const thirdDeployment = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('third'); } };",
        },
      },
    });

    assert(secondDeployment.type === "json");
    assert(thirdDeployment.type === "json");
    if (secondDeployment.type !== "json" || thirdDeployment.type !== "json") {
      return;
    }

    const secondTag = buildCloudflareDeploymentTag(
      secondDeployment.data.id,
      config.deploymentTagPrefix,
    );
    const appTag = buildCloudflareAppTag("tenant-app", config.deploymentTagPrefix);
    fetchMock
      .mockResolvedValueOnce(
        createSuccessResponse({
          id: "worker-script",
          startup_time_ms: 0,
          etag: "etag_2",
          modified_on: "2026-03-10T12:01:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        createErrorResponse(412, [{ code: 9001, message: "If-Match precondition failed" }]),
      )
      .mockResolvedValueOnce(createSuccessResponse([appTag, secondTag]))
      .mockResolvedValueOnce(
        createSuccessResponse({
          modified_on: "2026-03-10T12:01:00.000Z",
          script: {
            etag: "etag_2",
          },
        }),
      );

    await drainDurableHooks(fragment);

    const second = await getDeployment(secondDeployment.data.id);
    const third = await getDeployment(thirdDeployment.data.id);
    const app = await getApp("tenant-app");

    assert(second?.status === "succeeded");
    assert(second?.cloudflareEtag === "etag_2");
    assert(third?.status === "failed");
    assert(third?.attemptCount === 1);
    assert(third?.errorCode === "DEPLOYMENT_SUPERSEDED");
    expect(third?.errorMessage).toContain(secondDeployment.data.id);
    expect(app?.liveDeploymentId).toBe(secondDeployment.data.id);
    assert(app?.liveCloudflareEtag === "etag_2");
    assert(getFetchHeaders(1).get("if-match") === "etag_1");
    assert(getFetchHeaders(2).get("if-match") === "etag_1");
  });

  test("serializes the first deploy path locally so only one queued first deploy uploads", async () => {
    const firstDeployment = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('first'); } };",
        },
      },
    });
    const secondDeployment = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('second'); } };",
        },
      },
    });

    assert(firstDeployment.type === "json");
    assert(secondDeployment.type === "json");
    if (firstDeployment.type !== "json" || secondDeployment.type !== "json") {
      return;
    }

    fetchMock.mockResolvedValueOnce(
      createSuccessResponse({
        id: "worker-script",
        startup_time_ms: 0,
        etag: "etag_1",
        modified_on: "2026-03-10T12:00:00.000Z",
      }),
    );

    await drainDurableHooks(fragment);

    const first = await getDeployment(firstDeployment.data.id);
    const second = await getDeployment(secondDeployment.data.id);
    const app = await getApp("tenant-app");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    assert(first?.status === "succeeded");
    assert(second?.status === "failed");
    assert(second?.attemptCount === 0);
    assert(second?.errorCode === "DEPLOYMENT_SUPERSEDED");
    expect(second?.errorMessage).toContain(firstDeployment.data.id);
    expect(app?.liveDeploymentId).toBe(firstDeployment.data.id);
    assert(app?.liveCloudflareEtag === "etag_1");
    expect(app?.firstDeploymentLeaseId).toBeNull();
  });

  test("returns typed not found errors for missing apps and deployments", async () => {
    const appResponse = await fragment.callRoute("GET", "/apps/:appId", {
      pathParams: { appId: "missing-app" },
    });

    assert(appResponse.type === "error");
    if (appResponse.type === "error") {
      assert(appResponse.error.code === "APP_NOT_FOUND");
      assert(appResponse.status === 404);
    }

    const deploymentResponse = await fragment.callRoute("GET", "/deployments/:deploymentId", {
      pathParams: { deploymentId: "missing-deployment" },
    });

    assert(deploymentResponse.type === "error");
    if (deploymentResponse.type === "error") {
      assert(deploymentResponse.error.code === "DEPLOYMENT_NOT_FOUND");
      assert(deploymentResponse.status === 404);
    }

    const deploymentHistoryResponse = await fragment.callRoute("GET", "/apps/:appId/deployments", {
      pathParams: { appId: "missing-app" },
    });

    assert(deploymentHistoryResponse.type === "error");
    if (deploymentHistoryResponse.type === "error") {
      assert(deploymentHistoryResponse.error.code === "APP_NOT_FOUND");
      assert(deploymentHistoryResponse.status === 404);
    }
  });

  test("rejects unsupported deploy request types at contract validation", () => {
    const result = cloudflareDeployRequestSchema.safeParse({
      script: {
        type: "service-worker",
        entrypoint: "index.mjs",
        content: "addEventListener('fetch', (event) => event.respondWith(new Response('ok')));",
      },
    });

    assert(!result.success);
  });

  test("lists apps and deployment history for the backoffice", async () => {
    const firstDeployment = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('first'); } };",
        },
      },
    });

    assert(firstDeployment.type === "json");
    if (firstDeployment.type !== "json") {
      return;
    }

    await sleep(5);

    const secondDeployment = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "worker.mjs",
          content: "export default { async fetch() { return new Response('second'); } };",
        },
      },
    });

    assert(secondDeployment.type === "json");
    if (secondDeployment.type !== "json") {
      return;
    }

    await sleep(5);

    const otherAppDeployment = await fragment.callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId: "other-app" },
      body: {
        script: {
          type: "esmodule",
          entrypoint: "index.mjs",
          content: "export default { async fetch() { return new Response('other'); } };",
        },
      },
    });

    assert(otherAppDeployment.type === "json");
    if (otherAppDeployment.type !== "json") {
      return;
    }

    const appList = await fragment.callRoute("GET", "/apps");

    assert(appList.type === "json");
    if (appList.type !== "json") {
      return;
    }

    expect(appList.data.apps).toHaveLength(2);
    assert(appList.data.apps[0]?.id === "other-app");
    assert(appList.data.apps[1]?.id === "tenant-app");
    expect(appList.data.apps.find((app) => app.id === "tenant-app")?.latestDeployment?.id).toBe(
      secondDeployment.data.id,
    );

    const deploymentHistory = await fragment.callRoute("GET", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
    });

    assert(deploymentHistory.type === "json");
    if (deploymentHistory.type !== "json") {
      return;
    }

    expect(deploymentHistory.data.deployments.map((deployment) => deployment.id)).toEqual([
      secondDeployment.data.id,
      firstDeployment.data.id,
    ]);
  });
});
