import { assert, expect, test } from "vitest";

import {
  pathWithScriptViewMode,
  shouldRevalidateScriptSource,
  scriptViewModeFromSearchParam,
  searchParamsWithScriptViewMode,
} from "./script-view-mode";

test("reads supported script view modes and defaults invalid values to code", () => {
  assert(scriptViewModeFromSearchParam("graph") === "graph");
  assert(scriptViewModeFromSearchParam("split") === "split");
  assert(scriptViewModeFromSearchParam("code") === "code");
  assert(scriptViewModeFromSearchParam("unknown") === "code");
  assert(scriptViewModeFromSearchParam(null) === "code");
});

test("changes the script view without dropping the selected script", () => {
  const currentSearchParams = new URLSearchParams({ script: "starter", unrelated: "kept" });

  const nextSearchParams = searchParamsWithScriptViewMode(currentSearchParams, "graph");

  expect(Object.fromEntries(nextSearchParams)).toEqual({
    script: "starter",
    unrelated: "kept",
    scriptView: "graph",
  });
  assert(!currentSearchParams.has("scriptView"));
});

test("skips source revalidation for presentation-only navigations", () => {
  assert(
    !shouldRevalidateScriptSource({
      currentUrl: new URL("https://example.test/scripts?script=starter&scriptView=code"),
      nextUrl: new URL("https://example.test/scripts?scriptView=graph&script=starter"),
      defaultShouldRevalidate: true,
    }),
  );
  assert(
    !shouldRevalidateScriptSource({
      currentUrl: new URL("https://example.test/scripts?script=starter"),
      nextUrl: new URL("https://example.test/scripts?script=starter&scriptView=split"),
      defaultShouldRevalidate: true,
    }),
  );
});

test("keeps data-changing navigations eligible for revalidation", () => {
  const currentUrl = new URL("https://example.test/scripts?script=starter&scriptView=code");
  for (const nextUrl of [
    new URL("https://example.test/scripts?script=other&scriptView=graph"),
    new URL("https://example.test/scripts?script=starter&scriptView=code&refresh=1"),
    new URL("https://example.test/other?script=starter&scriptView=graph"),
    new URL("https://example.test/scripts?script=starter&scriptView=code"),
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

test("carries the script view across scope and tab paths", () => {
  assert(
    pathWithScriptViewMode("/backoffice/automations/org/acme/scripts", "split") ===
      "/backoffice/automations/org/acme/scripts?scriptView=split",
  );
  assert(
    pathWithScriptViewMode("/backoffice/automations/user/me/scripts?kept=yes", "graph") ===
      "/backoffice/automations/user/me/scripts?kept=yes&scriptView=graph",
  );
});
