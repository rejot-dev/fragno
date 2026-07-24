export type ScriptViewMode = "code" | "graph" | "split";

export const SCRIPT_VIEW_MODE_SEARCH_PARAM = "scriptView";

export function scriptViewModeFromSearchParam(value: string | null): ScriptViewMode {
  return value === "graph" || value === "split" ? value : "code";
}

export function searchParamsWithScriptViewMode(
  currentSearchParams: URLSearchParams,
  mode: ScriptViewMode,
): URLSearchParams {
  const nextSearchParams = new URLSearchParams(currentSearchParams);
  nextSearchParams.set(SCRIPT_VIEW_MODE_SEARCH_PARAM, mode);
  return nextSearchParams;
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
  return isOnlyScriptViewModeChange(currentUrl, nextUrl) ? false : defaultShouldRevalidate;
}

function isOnlyScriptViewModeChange(currentUrl: URL, nextUrl: URL): boolean {
  if (
    currentUrl.pathname !== nextUrl.pathname ||
    currentUrl.hash !== nextUrl.hash ||
    currentUrl.searchParams.get(SCRIPT_VIEW_MODE_SEARCH_PARAM) ===
      nextUrl.searchParams.get(SCRIPT_VIEW_MODE_SEARCH_PARAM)
  ) {
    return false;
  }

  const currentDataSearch = new URLSearchParams(currentUrl.searchParams);
  const nextDataSearch = new URLSearchParams(nextUrl.searchParams);
  currentDataSearch.delete(SCRIPT_VIEW_MODE_SEARCH_PARAM);
  nextDataSearch.delete(SCRIPT_VIEW_MODE_SEARCH_PARAM);
  currentDataSearch.sort();
  nextDataSearch.sort();
  return currentDataSearch.toString() === nextDataSearch.toString();
}

export function pathWithScriptViewMode(path: string, mode: ScriptViewMode): string {
  const [pathname, search = ""] = path.split("?", 2);
  const searchParams = searchParamsWithScriptViewMode(new URLSearchParams(search), mode);
  return `${pathname}?${searchParams.toString()}`;
}
