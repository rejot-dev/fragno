import {
  BACKOFFICE_WORKER_TOPOLOGY,
  type BackofficeReactRouterWorker,
  type BackofficeReactRouterWorkerId,
} from "../backoffice-worker-topology";

export const REACT_ROUTER_SERVER_BUNDLE_IDS = Object.keys(
  BACKOFFICE_WORKER_TOPOLOGY.reactRouterWorkers,
) as BackofficeReactRouterWorkerId[];

export const REACT_ROUTER_SERVER_BUNDLE_ENVIRONMENTS = REACT_ROUTER_SERVER_BUNDLE_IDS.map(
  (bundleId) => `ssrBundle_${bundleId}`,
);

export type ReactRouterServerBundleId = BackofficeReactRouterWorkerId;

type ReactRouterServerBundleBranchRoute = {
  file: string;
};

/** Returns every declared React Router Worker in stable topology order. */
export function getReactRouterWorkerEntries(): Array<
  [BackofficeReactRouterWorkerId, BackofficeReactRouterWorker]
> {
  return Object.entries(BACKOFFICE_WORKER_TOPOLOGY.reactRouterWorkers) as Array<
    [BackofficeReactRouterWorkerId, BackofficeReactRouterWorker]
  >;
}

/** Assigns each addressable route module to exactly one declared React Router Worker. */
export function assignReactRouterServerBundle(
  branch: readonly ReactRouterServerBundleBranchRoute[],
): ReactRouterServerBundleId {
  const routeFile = branch.at(-1)?.file;
  if (!routeFile) {
    throw new Error("React Router server bundle assignment received an empty route branch");
  }

  const routeModule = normalizeRouteModule(routeFile);
  const matches = getReactRouterWorkerEntries().filter(([, worker]) =>
    workerOwnsRouteModule(worker, routeModule),
  );

  if (matches.length === 0) {
    throw new Error(`No Backoffice React Router Worker owns route module '${routeModule}'`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple Backoffice React Router Workers own route module '${routeModule}': ${matches
        .map(([workerId]) => workerId)
        .join(", ")}`,
    );
  }

  return matches[0][0];
}

/** Selects the declared React Router Worker service that owns a request pathname. */
export function selectReactRouterServerBundle(pathname: string): ReactRouterServerBundleId {
  const entries = getReactRouterWorkerEntries();
  const matches = entries.filter(([, worker]) => workerMatchesRequestPath(worker, pathname));

  if (matches.length > 1) {
    throw new Error(
      `Multiple Backoffice React Router Workers match pathname '${pathname}': ${matches
        .map(([workerId]) => workerId)
        .join(", ")}`,
    );
  }
  if (matches.length === 1) {
    return matches[0][0];
  }

  return BACKOFFICE_WORKER_TOPOLOGY.fallbackRequestHandler;
}

function normalizeRouteModule(routeFile: string): string {
  const normalizedRouteFile = routeFile.replaceAll("\\", "/");
  const appDirectoryMarker = "/app/";
  const appDirectoryIndex = normalizedRouteFile.lastIndexOf(appDirectoryMarker);
  if (appDirectoryIndex >= 0) {
    return normalizedRouteFile.slice(appDirectoryIndex + appDirectoryMarker.length);
  }
  return normalizedRouteFile.replace(/^\.\//, "").replace(/^app\//, "");
}

function workerOwnsRouteModule(worker: BackofficeReactRouterWorker, routeModule: string): boolean {
  return (
    (worker.routeModules as readonly string[]).includes(routeModule) ||
    worker.routeModulePrefixes.some((prefix) => routeModule.startsWith(prefix))
  );
}

function workerMatchesRequestPath(worker: BackofficeReactRouterWorker, pathname: string): boolean {
  const isExcluded =
    worker.excludedRequestPathPrefixes.some((prefix) => isPathWithin(pathname, prefix)) ||
    worker.excludedRequestPathRegularExpressions.some((pattern) =>
      new RegExp(pattern).test(pathname),
    );
  if (isExcluded) {
    return false;
  }

  return (
    worker.requestPathPrefixes.some((prefix) => isPathWithin(pathname, prefix)) ||
    worker.requestPathRegularExpressions.some((pattern) => new RegExp(pattern).test(pathname))
  );
}

function isPathWithin(pathname: string, pathPrefix: string): boolean {
  return pathname === pathPrefix || pathname.startsWith(`${pathPrefix}/`);
}
