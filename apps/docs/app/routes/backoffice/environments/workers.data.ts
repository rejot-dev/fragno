import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import type {
  CloudflareAppState,
  CloudflareAppSummary,
  CloudflareDeployRequest,
  CloudflareDeploymentDetail,
  CloudflareDeploymentSummary,
} from "@fragno-dev/cloudflare-fragment";

import { getCloudflareWorkersDurableObject } from "@/cloudflare/cloudflare-utils";
import type { CloudflareFragment } from "@/fragno/cloudflare";

const createCloudflareRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const cloudflareDo = getCloudflareWorkersDurableObject(context, orgId);

  return createRouteCaller<CloudflareFragment>({
    baseUrl: request.url,
    mountRoute: `/api/cloudflare/${orgId}`,
    baseHeaders: request.headers,
    fetch: async (outboundRequest) => {
      const url = new URL(outboundRequest.url);
      const prefix = `/api/cloudflare/${orgId}`;

      if (url.pathname.startsWith(prefix)) {
        const suffix = url.pathname.slice(prefix.length);
        url.pathname = `/api/cloudflare${suffix}`;
      }

      url.searchParams.set("orgId", orgId);

      return cloudflareDo.fetch(new Request(url.toString(), outboundRequest));
    },
  });
};

type CloudflareAppsResult = {
  apps: CloudflareAppSummary[];
  error: string | null;
};

type CloudflareAppStateResult = {
  app: CloudflareAppState | null;
  error: string | null;
};

type QueueCloudflareDeploymentResult = {
  deployment: CloudflareDeploymentSummary | null;
  error: string | null;
};

type CloudflareDeploymentResult = {
  deployment: CloudflareDeploymentDetail | null;
  error: string | null;
};

export async function fetchCloudflareApps(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<CloudflareAppsResult> {
  try {
    const callRoute = createCloudflareRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/apps");

    if (response.type === "json") {
      return { apps: response.data.apps ?? [], error: null };
    }

    if (response.type === "error") {
      return { apps: [], error: response.error.message };
    }

    return { apps: [], error: `Failed to fetch workers (${response.status}).` };
  } catch (error) {
    return {
      apps: [],
      error: error instanceof Error ? error.message : "Failed to load workers.",
    };
  }
}

export async function fetchCloudflareAppState(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  appId: string,
): Promise<CloudflareAppStateResult> {
  try {
    const callRoute = createCloudflareRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/apps/:appId", {
      pathParams: { appId },
    });

    if (response.type === "json") {
      return {
        app: response.data as CloudflareAppState,
        error: null,
      };
    }

    if (response.type === "error") {
      return {
        app: null,
        error: response.error.message,
      };
    }

    return {
      app: null,
      error: `Failed to fetch worker state (${response.status}).`,
    };
  } catch (error) {
    return {
      app: null,
      error: error instanceof Error ? error.message : "Failed to load worker state.",
    };
  }
}

export async function queueCloudflareDeployment(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  appId: string,
  payload: CloudflareDeployRequest,
): Promise<QueueCloudflareDeploymentResult> {
  try {
    const callRoute = createCloudflareRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/apps/:appId/deployments", {
      pathParams: { appId },
      body: payload,
    });

    if (response.type === "json") {
      return {
        deployment: response.data as CloudflareDeploymentSummary,
        error: null,
      };
    }

    if (response.type === "error") {
      return {
        deployment: null,
        error: response.error.message,
      };
    }

    return {
      deployment: null,
      error: `Failed to queue deployment (${response.status}).`,
    };
  } catch (error) {
    return {
      deployment: null,
      error: error instanceof Error ? error.message : "Failed to queue deployment.",
    };
  }
}

export async function fetchCloudflareDeployment(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  deploymentId: string,
): Promise<CloudflareDeploymentResult> {
  try {
    const callRoute = createCloudflareRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/deployments/:deploymentId", {
      pathParams: { deploymentId },
    });

    if (response.type === "json") {
      return {
        deployment: response.data as CloudflareDeploymentDetail,
        error: null,
      };
    }

    if (response.type === "error") {
      return {
        deployment: null,
        error: response.error.message,
      };
    }

    return {
      deployment: null,
      error: `Failed to fetch deployment detail (${response.status}).`,
    };
  } catch (error) {
    return {
      deployment: null,
      error: error instanceof Error ? error.message : "Failed to load deployment detail.",
    };
  }
}
