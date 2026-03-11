import { resolveCloudflareScriptName } from "@fragno-dev/cloudflare-fragment/script-name";

export const DEV_CLOUDFLARE_WORKER_ROUTE_PREFIX = "/__dev/workers";

const DEVELOPMENT_MODE = "development";
const FORWARDED_REQUEST_HEADER_DENYLIST = [
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "connection",
  "cookie",
  "host",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
] as const;

export const isCloudflareWorkerDispatchEnabled = (mode: string) => mode === DEVELOPMENT_MODE;

export const resolveCloudflareWorkerScriptName = (orgId: string, appId: string) => {
  return resolveCloudflareScriptName(appId, {
    scriptNamePrefix: `fragno-${orgId}`,
    scriptNameSuffix: "worker",
  });
};

export const buildCloudflareWorkerDispatchPath = (orgId: string, appId: string) => {
  return `${DEV_CLOUDFLARE_WORKER_ROUTE_PREFIX}/${encodeURIComponent(orgId)}/${encodeURIComponent(appId)}`;
};

export const rewriteCloudflareWorkerDispatchUrl = (
  requestUrl: Request | URL | string,
  orgId: string,
  appId: string,
) => {
  const url = new URL(requestUrl instanceof Request ? requestUrl.url : requestUrl);
  const prefix = buildCloudflareWorkerDispatchPath(orgId, appId);

  if (url.pathname === prefix) {
    url.pathname = "/";
    return url;
  }

  if (url.pathname.startsWith(`${prefix}/`)) {
    const suffix = url.pathname.slice(prefix.length);
    url.pathname = suffix.length > 0 ? suffix : "/";
  }

  return url;
};

export const buildCloudflareWorkerDispatchRequest = (
  request: Request,
  orgId: string,
  appId: string,
  scriptName: string,
) => {
  const targetUrl = rewriteCloudflareWorkerDispatchUrl(request, orgId, appId);
  const headers = new Headers(request.headers);

  for (const header of FORWARDED_REQUEST_HEADER_DENYLIST) {
    headers.delete(header);
  }

  headers.set("x-fragno-worker-org-id", orgId);
  headers.set("x-fragno-worker-app-id", appId);
  headers.set("x-fragno-worker-script-name", scriptName);

  const forwardedRequestInit: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    signal: request.signal,
  };

  if (forwardedRequestInit.body !== undefined) {
    forwardedRequestInit.duplex = "half";
  }

  const forwardedRequest = new Request(targetUrl.toString(), forwardedRequestInit);

  return forwardedRequest;
};
