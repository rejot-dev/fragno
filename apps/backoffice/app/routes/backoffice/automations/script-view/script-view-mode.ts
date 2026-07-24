export type ScriptViewMode = "code" | "graph" | "split";
export type WorkflowGraphDetailMode = "simple" | "verbose";

export interface ScriptPresentation {
  viewMode: ScriptViewMode;
  graphDetailMode: WorkflowGraphDetailMode;
}

export const SCRIPT_VIEW_MODE_SEARCH_PARAM = "scriptView";
export const WORKFLOW_GRAPH_DETAIL_MODE_SEARCH_PARAM = "graphDetail";

export function scriptViewModeFromSearchParam(value: string | null): ScriptViewMode {
  return value === "graph" || value === "split" ? value : "code";
}

export function workflowGraphDetailModeFromSearchParam(
  value: string | null,
): WorkflowGraphDetailMode {
  return value === "verbose" ? "verbose" : "simple";
}

export function searchParamsWithScriptViewMode(
  currentSearchParams: URLSearchParams,
  mode: ScriptViewMode,
): URLSearchParams {
  const nextSearchParams = new URLSearchParams(currentSearchParams);
  nextSearchParams.set(SCRIPT_VIEW_MODE_SEARCH_PARAM, mode);
  return nextSearchParams;
}

export function searchParamsWithWorkflowGraphDetailMode(
  currentSearchParams: URLSearchParams,
  mode: WorkflowGraphDetailMode,
): URLSearchParams {
  const nextSearchParams = new URLSearchParams(currentSearchParams);
  nextSearchParams.set(WORKFLOW_GRAPH_DETAIL_MODE_SEARCH_PARAM, mode);
  return nextSearchParams;
}

export function searchParamsWithScriptPresentation(
  currentSearchParams: URLSearchParams,
  { viewMode, graphDetailMode }: ScriptPresentation,
): URLSearchParams {
  return searchParamsWithWorkflowGraphDetailMode(
    searchParamsWithScriptViewMode(currentSearchParams, viewMode),
    graphDetailMode,
  );
}

export function shouldRevalidateScriptSource({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: {
  currentUrl: URL;
  nextUrl: URL;
  defaultShouldRevalidate: boolean;
}): boolean {
  return isOnlyScriptPresentationChange(currentUrl, nextUrl) ? false : defaultShouldRevalidate;
}

function isOnlyScriptPresentationChange(currentUrl: URL, nextUrl: URL): boolean {
  if (currentUrl.pathname !== nextUrl.pathname || currentUrl.hash !== nextUrl.hash) {
    return false;
  }

  const presentationChanged = [
    SCRIPT_VIEW_MODE_SEARCH_PARAM,
    WORKFLOW_GRAPH_DETAIL_MODE_SEARCH_PARAM,
  ].some(
    (searchParam) =>
      currentUrl.searchParams.get(searchParam) !== nextUrl.searchParams.get(searchParam),
  );
  if (!presentationChanged) {
    return false;
  }

  const currentDataSearch = new URLSearchParams(currentUrl.searchParams);
  const nextDataSearch = new URLSearchParams(nextUrl.searchParams);
  for (const searchParam of [
    SCRIPT_VIEW_MODE_SEARCH_PARAM,
    WORKFLOW_GRAPH_DETAIL_MODE_SEARCH_PARAM,
  ]) {
    currentDataSearch.delete(searchParam);
    nextDataSearch.delete(searchParam);
  }
  currentDataSearch.sort();
  nextDataSearch.sort();
  return currentDataSearch.toString() === nextDataSearch.toString();
}

export function pathWithScriptPresentation(
  path: string,
  { viewMode, graphDetailMode }: ScriptPresentation,
): string {
  const [pathname, search = ""] = path.split("?", 2);
  const searchParams = searchParamsWithScriptPresentation(new URLSearchParams(search), {
    viewMode,
    graphDetailMode,
  });
  return `${pathname}?${searchParams.toString()}`;
}
