import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { createCloudflareApiClient } from "./cloudflare-api";
import { cloudflareDeployRequestSchema } from "./contracts";
import { cloudflareFragmentDefinition, type CloudflareFragmentConfig } from "./definition";
import { buildCloudflareAppTag, buildCloudflareDeploymentTag } from "./deployment-tag";
import { cloudflareRoutesFactory } from "./routes";

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
    db.findFirst("app", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id)));
  const getDeployment = async (id: string) =>
    db.findFirst("deployment", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id)));
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

    expect(response.type).toBe("json");
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
    expect(app?.scriptName).toBe("fragno-tenant-app-worker");

    const appState = await fragment.callRoute("GET", "/apps/:appId", {
      pathParams: { appId: "tenant-app" },
    });

    expect(appState.type).toBe("json");
    if (appState.type !== "json") {
      return;
    }

    expect(appState.data.latestDeployment?.id).toBe(response.data.id);
    expect(appState.data.latestDeployment?.status).toBe("queued");
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

    expect(queued.type).toBe("json");
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
    expect(deployment?.status).toBe("succeeded");
    expect(deployment?.cloudflareEtag).toBe("etag_123");
    expect(deployment?.attemptCount).toBe(1);

    const app = await getApp("tenant-app");
    expect(app?.liveDeploymentId).toBe(queued.data.id);
    expect(app?.liveCloudflareEtag).toBe("etag_123");

    const detail = await fragment.callRoute("GET", "/deployments/:deploymentId", {
      pathParams: { deploymentId: queued.data.id },
    });

    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      return;
    }

    expect(detail.data.status).toBe("succeeded");
    expect(detail.data.sourceCode).toBe(
      "export default { async fetch() { return new Response('ok'); } };",
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

    expect(firstDeployment.type).toBe("json");
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

    expect(secondDeployment.type).toBe("json");
    if (secondDeployment.type !== "json") {
      return;
    }

    const appState = await fragment.callRoute("GET", "/apps/:appId", {
      pathParams: { appId: "tenant-app" },
    });

    expect(appState.type).toBe("json");
    if (appState.type !== "json") {
      return;
    }

    expect(appState.data.latestDeployment?.id).toBe(secondDeployment.data.id);
    expect(appState.data.latestDeployment?.status).toBe("queued");
    expect(appState.data.liveDeployment?.id).toBe(firstDeployment.data.id);
    expect(appState.data.liveDeployment?.status).toBe("succeeded");
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

    expect(firstDeployment.type).toBe("json");
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

    expect(secondDeployment.type).toBe("json");
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

    expect(thirdDeployment.type).toBe("json");
    if (thirdDeployment.type !== "json") {
      return;
    }

    await drainDurableHooks(fragment);

    const second = await getDeployment(secondDeployment.data.id);
    const third = await getDeployment(thirdDeployment.data.id);
    const app = await getApp("tenant-app");

    expect(second?.status).toBe("failed");
    expect(second?.attemptCount).toBe(1);
    expect(second?.errorCode).toBe("1001");
    expect(second?.errorMessage).toBe("Invalid API token");
    expect(third?.status).toBe("succeeded");
    expect(third?.cloudflareEtag).toBe("etag_3");
    expect(app?.liveDeploymentId).toBe(thirdDeployment.data.id);
    expect(app?.liveCloudflareEtag).toBe("etag_3");
    expect(getFetchHeaders(2).get("if-match")).toBe("etag_1");
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

    expect(firstDeployment.type).toBe("json");
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

    expect(secondDeployment.type).toBe("json");
    expect(thirdDeployment.type).toBe("json");
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

    expect(second?.status).toBe("succeeded");
    expect(second?.cloudflareEtag).toBe("etag_2");
    expect(third?.status).toBe("failed");
    expect(third?.attemptCount).toBe(1);
    expect(third?.errorCode).toBe("DEPLOYMENT_SUPERSEDED");
    expect(third?.errorMessage).toContain(secondDeployment.data.id);
    expect(app?.liveDeploymentId).toBe(secondDeployment.data.id);
    expect(app?.liveCloudflareEtag).toBe("etag_2");
    expect(getFetchHeaders(1).get("if-match")).toBe("etag_1");
    expect(getFetchHeaders(2).get("if-match")).toBe("etag_1");
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

    expect(firstDeployment.type).toBe("json");
    expect(secondDeployment.type).toBe("json");
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
    expect(first?.status).toBe("succeeded");
    expect(second?.status).toBe("failed");
    expect(second?.attemptCount).toBe(0);
    expect(second?.errorCode).toBe("DEPLOYMENT_SUPERSEDED");
    expect(second?.errorMessage).toContain(firstDeployment.data.id);
    expect(app?.liveDeploymentId).toBe(firstDeployment.data.id);
    expect(app?.liveCloudflareEtag).toBe("etag_1");
    expect(app?.firstDeploymentLeaseId).toBeNull();
  });

  test("returns typed not found errors for missing apps and deployments", async () => {
    const appResponse = await fragment.callRoute("GET", "/apps/:appId", {
      pathParams: { appId: "missing-app" },
    });

    expect(appResponse.type).toBe("error");
    if (appResponse.type === "error") {
      expect(appResponse.error.code).toBe("APP_NOT_FOUND");
      expect(appResponse.status).toBe(404);
    }

    const deploymentResponse = await fragment.callRoute("GET", "/deployments/:deploymentId", {
      pathParams: { deploymentId: "missing-deployment" },
    });

    expect(deploymentResponse.type).toBe("error");
    if (deploymentResponse.type === "error") {
      expect(deploymentResponse.error.code).toBe("DEPLOYMENT_NOT_FOUND");
      expect(deploymentResponse.status).toBe(404);
    }

    const deploymentHistoryResponse = await fragment.callRoute("GET", "/apps/:appId/deployments", {
      pathParams: { appId: "missing-app" },
    });

    expect(deploymentHistoryResponse.type).toBe("error");
    if (deploymentHistoryResponse.type === "error") {
      expect(deploymentHistoryResponse.error.code).toBe("APP_NOT_FOUND");
      expect(deploymentHistoryResponse.status).toBe(404);
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

    expect(result.success).toBe(false);
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

    expect(firstDeployment.type).toBe("json");
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

    expect(secondDeployment.type).toBe("json");
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

    expect(otherAppDeployment.type).toBe("json");
    if (otherAppDeployment.type !== "json") {
      return;
    }

    const appList = await fragment.callRoute("GET", "/apps");

    expect(appList.type).toBe("json");
    if (appList.type !== "json") {
      return;
    }

    expect(appList.data.apps).toHaveLength(2);
    expect(appList.data.apps[0]?.id).toBe("other-app");
    expect(appList.data.apps[1]?.id).toBe("tenant-app");
    expect(appList.data.apps.find((app) => app.id === "tenant-app")?.latestDeployment?.id).toBe(
      secondDeployment.data.id,
    );

    const deploymentHistory = await fragment.callRoute("GET", "/apps/:appId/deployments", {
      pathParams: { appId: "tenant-app" },
    });

    expect(deploymentHistory.type).toBe("json");
    if (deploymentHistory.type !== "json") {
      return;
    }

    expect(deploymentHistory.data.deployments.map((deployment) => deployment.id)).toEqual([
      secondDeployment.data.id,
      firstDeployment.data.id,
    ]);
  });
});
