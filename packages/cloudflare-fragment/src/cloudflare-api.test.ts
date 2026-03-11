import { describe, expect, test, vi } from "vitest";
import {
  buildCloudflareScriptTags,
  createCloudflareApiClient,
  deployCloudflareWorker,
  getCloudflareCurrentDeployment,
  listCloudflareScriptTags,
  reconcileCloudflareWorkerDeployment,
} from "./cloudflare-api";
import { buildCloudflareAppTag, buildCloudflareDeploymentTag } from "./deployment-tag";

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

describe("cloudflare-api helpers", () => {
  test("deployCloudflareWorker uploads a module through the SDK and forwards If-Match", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createSuccessResponse({
        id: "worker-script",
        startup_time_ms: 0,
        etag: "etag_123",
        modified_on: "2026-03-10T12:00:00.000Z",
      }),
    );
    const client = createCloudflareApiClient({
      apiToken: "cf_test_token",
      fetchImplementation: fetchMock,
    });

    const response = await deployCloudflareWorker(client, {
      accountId: "acct_test",
      dispatchNamespace: "dispatch-prod",
      scriptName: "fragno-tenant-app-worker",
      entrypoint: "index.mjs",
      moduleContent: "export default { async fetch() { return new Response('ok'); } };",
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      tags: buildCloudflareScriptTags(["fragno-app-tenant-app", "fragno-dep-dep-123"], ["release"]),
      ifMatch: "etag_base_123",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers as HeadersInit | undefined);

    expect(String(url)).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct_test/workers/dispatch/namespaces/dispatch-prod/scripts/fragno-tenant-app-worker",
    );
    expect(init?.method?.toUpperCase()).toBe("PUT");
    expect(headers.get("if-match")).toBe("etag_base_123");
    expect(response).toMatchObject({
      etag: "etag_123",
      modified_on: "2026-03-10T12:00:00.000Z",
    });
  });

  test("listCloudflareScriptTags returns an empty list when the script does not exist", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(createErrorResponse(404, [{ code: 10007, message: "Worker not found" }]));
    const client = createCloudflareApiClient({
      apiToken: "cf_test_token",
      fetchImplementation: fetchMock,
    });

    const tags = await listCloudflareScriptTags(client, {
      accountId: "acct_test",
      dispatchNamespace: "dispatch-prod",
      scriptName: "missing-worker",
    });

    expect(tags).toEqual([]);
  });

  test("getCloudflareCurrentDeployment returns the current deployment id from tags", async () => {
    const appTag = buildCloudflareAppTag("tenant-app", "fragno-deployment");
    const deploymentTag = buildCloudflareDeploymentTag("dep_123", "fragno-deployment");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(createSuccessResponse([appTag, deploymentTag]));
    const client = createCloudflareApiClient({
      apiToken: "cf_test_token",
      fetchImplementation: fetchMock,
    });

    const currentDeployment = await getCloudflareCurrentDeployment(client, {
      accountId: "acct_test",
      dispatchNamespace: "dispatch-prod",
      scriptName: "fragno-tenant-app-worker",
      deploymentTagPrefix: "fragno-deployment",
    });

    expect(currentDeployment).toEqual({
      deploymentTag,
      deploymentId: "dep-123",
    });
  });

  test("getCloudflareCurrentDeployment returns null when there is no deployment tag", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createSuccessResponse(["release"]));
    const client = createCloudflareApiClient({
      apiToken: "cf_test_token",
      fetchImplementation: fetchMock,
    });

    const currentDeployment = await getCloudflareCurrentDeployment(client, {
      accountId: "acct_test",
      dispatchNamespace: "dispatch-prod",
      scriptName: "fragno-tenant-app-worker",
      deploymentTagPrefix: "fragno-deployment",
    });

    expect(currentDeployment).toBeNull();
  });

  test("reconcileCloudflareWorkerDeployment treats a 412 as already deployed when the remote tag matches", async () => {
    const appTag = buildCloudflareAppTag("tenant-app", "fragno-deployment");
    const deploymentTag = buildCloudflareDeploymentTag("dep_123", "fragno-deployment");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createErrorResponse(412, [{ code: 9001, message: "If-Match precondition failed" }]),
      )
      .mockResolvedValueOnce(createSuccessResponse([appTag, deploymentTag]))
      .mockResolvedValueOnce(
        createSuccessResponse({
          modified_on: "2026-03-10T12:00:00.000Z",
          script: {
            etag: "etag_123",
          },
        }),
      );
    const client = createCloudflareApiClient({
      apiToken: "cf_test_token",
      fetchImplementation: fetchMock,
    });

    const result = await reconcileCloudflareWorkerDeployment(client, {
      accountId: "acct_test",
      dispatchNamespace: "dispatch-prod",
      appId: "tenant-app",
      deploymentId: "dep_123",
      expectedLiveEtag: "etag_prev",
      deploymentTagPrefix: "fragno-deployment",
      scriptName: "fragno-tenant-app-worker",
      entrypoint: "index.mjs",
      moduleContent: "export default {};",
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      scriptTags: ["release"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstHeaders = new Headers((fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as HeadersInit);
    expect(firstHeaders.get("if-match")).toBe("etag_prev");
    expect(result).toEqual({
      action: "already-deployed",
      deploymentTag,
      currentDeploymentTag: deploymentTag,
      currentDeploymentId: "dep-123",
      currentEtag: "etag_123",
      currentModifiedOn: "2026-03-10T12:00:00.000Z",
    });
  });

  test("reconcileCloudflareWorkerDeployment reports superseded deployments on a stale If-Match", async () => {
    const appTag = buildCloudflareAppTag("tenant-app", "fragno-deployment");
    const currentDeploymentTag = buildCloudflareDeploymentTag("dep_456", "fragno-deployment");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createErrorResponse(412, [{ code: 9001, message: "If-Match precondition failed" }]),
      )
      .mockResolvedValueOnce(createSuccessResponse([appTag, currentDeploymentTag]))
      .mockResolvedValueOnce(
        createSuccessResponse({
          modified_on: "2026-03-10T13:00:00.000Z",
          script: {
            etag: "etag_456",
          },
        }),
      );
    const client = createCloudflareApiClient({
      apiToken: "cf_test_token",
      fetchImplementation: fetchMock,
    });

    const result = await reconcileCloudflareWorkerDeployment(client, {
      accountId: "acct_test",
      dispatchNamespace: "dispatch-prod",
      appId: "tenant-app",
      deploymentId: "dep_123",
      expectedLiveEtag: "etag_122",
      deploymentTagPrefix: "fragno-deployment",
      scriptName: "fragno-tenant-app-worker",
      entrypoint: "index.mjs",
      moduleContent: "export default {};",
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      scriptTags: ["release"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      action: "superseded",
      deploymentTag: buildCloudflareDeploymentTag("dep_123", "fragno-deployment"),
      currentDeploymentTag,
      currentDeploymentId: "dep-456",
      currentEtag: "etag_456",
      currentModifiedOn: "2026-03-10T13:00:00.000Z",
    });
  });
});
