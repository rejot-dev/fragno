import { assert, expect, test } from "vitest";

import {
  pathWithScriptPresentation,
  searchParamsWithScriptViewMode,
  searchParamsWithWorkflowGraphDetailMode,
  shouldRevalidateScriptSource,
  scriptViewModeFromSearchParam,
  workflowGraphDetailModeFromSearchParam,
} from "./script-view-mode";

test("reads supported script view modes and defaults invalid values to code", () => {
  assert(scriptViewModeFromSearchParam("graph") === "graph");
  assert(scriptViewModeFromSearchParam("split") === "split");
  assert(scriptViewModeFromSearchParam("code") === "code");
  assert(scriptViewModeFromSearchParam("unknown") === "code");
  assert(scriptViewModeFromSearchParam(null) === "code");
});

test("reads workflow graph detail modes and defaults invalid values to simple", () => {
  assert(workflowGraphDetailModeFromSearchParam("simple") === "simple");
  assert(workflowGraphDetailModeFromSearchParam("verbose") === "verbose");
  assert(workflowGraphDetailModeFromSearchParam("unknown") === "simple");
  assert(workflowGraphDetailModeFromSearchParam(null) === "simple");
});

test("changes presentation modes without dropping the selected script", () => {
  const currentSearchParams = new URLSearchParams({ script: "starter", unrelated: "kept" });

  const withViewMode = searchParamsWithScriptViewMode(currentSearchParams, "graph");
  const withDetailMode = searchParamsWithWorkflowGraphDetailMode(withViewMode, "verbose");

  expect(Object.fromEntries(withDetailMode)).toEqual({
    script: "starter",
    unrelated: "kept",
    scriptView: "graph",
    graphDetail: "verbose",
  });
  assert(!currentSearchParams.has("scriptView"));
  assert(!currentSearchParams.has("graphDetail"));
});

test("skips source revalidation for presentation-only navigations", () => {
  for (const [currentUrl, nextUrl] of [
    [
      "https://example.test/scripts?script=starter&scriptView=code",
      "https://example.test/scripts?scriptView=graph&script=starter",
    ],
    [
      "https://example.test/scripts?script=starter",
      "https://example.test/scripts?script=starter&scriptView=split",
    ],
    [
      "https://example.test/scripts?script=starter&scriptView=graph&graphDetail=simple",
      "https://example.test/scripts?graphDetail=verbose&scriptView=graph&script=starter",
    ],
    [
      "https://example.test/scripts?script=starter&scriptView=code&graphDetail=simple",
      "https://example.test/scripts?script=starter&scriptView=split&graphDetail=verbose",
    ],
  ]) {
    assert(
      !shouldRevalidateScriptSource({
        currentUrl: new URL(currentUrl),
        nextUrl: new URL(nextUrl),
        defaultShouldRevalidate: true,
      }),
    );
  }
});

test("keeps data-changing navigations eligible for revalidation", () => {
  const currentUrl = new URL(
    "https://example.test/scripts?script=starter&scriptView=code&graphDetail=simple",
  );
  for (const nextUrl of [
    new URL("https://example.test/scripts?script=other&scriptView=graph&graphDetail=verbose"),
    new URL(
      "https://example.test/scripts?script=starter&scriptView=code&graphDetail=simple&refresh=1",
    ),
    new URL("https://example.test/other?script=starter&scriptView=graph&graphDetail=verbose"),
    new URL("https://example.test/scripts?script=starter&scriptView=code&graphDetail=simple"),
  ]) {
    assert(
      shouldRevalidateScriptSource({
        currentUrl,
        nextUrl,
        defaultShouldRevalidate: true,
      }),
    );
  }
});

test("preserves the router's default decision for non-presentation navigations", () => {
  assert(
    !shouldRevalidateScriptSource({
      currentUrl: new URL("https://example.test/scripts?script=starter"),
      nextUrl: new URL("https://example.test/scripts?script=other"),
      defaultShouldRevalidate: false,
    }),
  );
});

test("carries script presentation across scope and tab paths", () => {
  assert(
    pathWithScriptPresentation("/backoffice/automations/org/acme/scripts", {
      viewMode: "split",
      graphDetailMode: "verbose",
    }) === "/backoffice/automations/org/acme/scripts?scriptView=split&graphDetail=verbose",
  );
  assert(
    pathWithScriptPresentation("/backoffice/automations/user/me/scripts?kept=yes", {
      viewMode: "graph",
      graphDetailMode: "simple",
    }) === "/backoffice/automations/user/me/scripts?kept=yes&scriptView=graph&graphDetail=simple",
  );
});
