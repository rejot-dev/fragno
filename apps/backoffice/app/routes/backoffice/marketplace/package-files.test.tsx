import { assert, describe, test } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";

import { createFileTree } from "@/file-collection/create-file-tree";

import { MarketplacePackageFiles } from "./package-files";
import type {
  MarketplacePackageExplorerData,
  MarketplacePackageSelectedContent,
} from "./package-files-model";

const workflowSource = {
  path: "/package/1.0.0/automations/daily-report.workflow.js",
  source: `defineWorkflow({ name: "daily-report" }, async (_event, step) => {
    await step.do("send report", async () => {});
  });`,
};

const packageData: MarketplacePackageExplorerData = {
  state: "ready",
  fileTree: createFileTree([
    {
      kind: "file",
      path: "1.0.0/automations/daily-report.workflow.js",
      sizeBytes: workflowSource.source.length,
      contentType: "text/javascript",
      updatedAt: null,
      metadata: null,
    },
  ]),
  selectedVersion: "1.0.0",
  overviewPath: null,
};

describe("MarketplacePackageFiles", () => {
  test("defaults to overview content and omits the old badges", () => {
    const markup = renderMarketplacePackages("/backoffice/marketplace/example");

    assert(markup.includes("No package overview"));
    assert(!markup.includes('aria-label="Marketplace package sections"'));
    assert(!markup.includes("Package contents"));
    assert(!markup.includes("Read only"));
    assert(!markup.includes("2 releases"));
    assert(!markup.includes("could not be found"));
  });

  test("reports an explicitly requested package path that is missing", () => {
    const markup = renderMarketplacePackages(
      "/backoffice/marketplace/example?packageTab=files&packagePath=%2Fpackage%2Fmissing.txt",
    );

    assert(markup.includes("Package path &#x27;/package/missing.txt&#x27; could not be found."));
  });

  test("renders workflow file tabs without loading their sources", () => {
    const markup = renderMarketplacePackages(
      "/backoffice/marketplace/example?packageTab=workflows",
    );

    assert(markup.includes("daily-report.workflow.js"));
    assert(markup.includes("Select a workflow"));
    assert(!markup.includes('aria-label="Workflow graph"'));
  });

  test("parses fetched workflow sources with the shared workflow graph on the client", () => {
    const markup = renderMarketplacePackages(
      `/backoffice/marketplace/example?packageTab=workflows&packagePath=${encodeURIComponent(workflowSource.path)}`,
      { path: workflowSource.path, text: workflowSource.source },
    );

    assert(markup.includes('aria-label="Workflow graph"'));
    assert(markup.includes("daily-report"));
    assert(markup.includes("send report"));
    assert(markup.includes("daily-report.workflow.js"));
  });
});

function renderMarketplacePackages(
  initialEntry: string,
  selectedContent: MarketplacePackageSelectedContent | null = null,
): string {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: <MarketplacePackageFiles data={packageData} selectedContent={selectedContent} />,
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}
