export type WorkersView = "new" | "detail";

type WorkersRouteLocation = {
  pathname: string;
  search: string;
};

const WORKERS_ROUTE_PATH = "/backoffice/environments/workers";

export function readWorkersSearchState(search: string): {
  view: WorkersView;
  workerId: string | null;
} {
  const searchParams = new URLSearchParams(search);
  const view: WorkersView = searchParams.get("view") === "new" ? "new" : "detail";

  return {
    view,
    workerId: view === "detail" ? readWorkerId(searchParams.get("worker")) : null,
  };
}

export function readWorkersRouteState(
  location: WorkersRouteLocation | URL | null | undefined,
): { view: WorkersView; workerId: string | null } | null {
  if (!location) {
    return null;
  }

  const pathname = normalizeWorkersPathname(location.pathname);
  if (pathname !== WORKERS_ROUTE_PATH) {
    return null;
  }

  return readWorkersSearchState(location.search);
}

export function toWorkersPath(options: { view?: WorkersView; workerId?: string }) {
  const params = new URLSearchParams();
  if (options.view === "new") {
    params.set("view", "new");
  } else if (options.workerId) {
    params.set("worker", options.workerId);
  }

  const query = params.toString();
  return query ? `${WORKERS_ROUTE_PATH}?${query}` : WORKERS_ROUTE_PATH;
}

function normalizeWorkersPathname(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

function readWorkerId(value: string | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
