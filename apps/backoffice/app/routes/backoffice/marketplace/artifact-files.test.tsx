import { assert, describe, test } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";

import { MarketplaceArtifactFiles, MarketplaceArtifactWorkflowGraphs } from "./artifact-files";
import type { MarketplaceArtifactExplorerData } from "./artifact-files-model";

const workflowSource = {
  path: "/artifact/1.0.0/automations/daily-report.workflow.js",
  source: `defineWorkflow({ name: "daily-report" }, async (_event, step) => {
    await step.do("send report", async () => {});
  });`,
};

const artifactData: MarketplaceArtifactExplorerData = {
  state: "ready",
  tree: [],
  selectedVersion: "1.0.0",
  defaultPath: "/artifact/1.0.0/",
  detailsByPath: {
    "/artifact/1.0.0/automations/daily-report.workflow.js": {
      node: {
        kind: "file",
        path: "/artifact/1.0.0/automations/daily-report.workflow.js",
        name: "daily-report.workflow.js",
        title: "daily-report.workflow.js",
        mountPoint: "/artifact",
        mountTitle: "Package contents",
        mountKind: "custom",
        readOnly: true,
        persistence: "persistent",
        contentType: "text/javascript",
      },
      fields: [],
      metadata: null,
      textContent: null,
      capabilities: { canCreateFolder: false, canWriteText: false, canDelete: false },
    },
  },
  overviewPath: "/artifact/README.md",
};

describe("MarketplaceArtifactFiles", () => {
  test("defaults to the metadata-only files tab and omits the old badges", () => {
    const markup = renderMarketplaceArtifacts("/backoffice/marketplace/example");

    assert(markup.includes("This workspace has no filesystems yet."));
    assert(markup.includes("Overview"));
    assert(markup.includes("Workflows"));
    assert(markup.includes("Files"));
    assert(!markup.includes("Read only"));
    assert(!markup.includes("2 releases"));
    assert(!markup.includes("could not be found"));
  });

  test("reports an explicitly requested artifact path that is missing", () => {
    const markup = renderMarketplaceArtifacts(
      "/backoffice/marketplace/example?artifactTab=files&artifactPath=%2Fartifact%2Fmissing.txt",
    );

    assert(markup.includes("Artifact path &#x27;/artifact/missing.txt&#x27; could not be found."));
  });

  test("renders workflow file tabs without loading their sources", () => {
    const markup = renderMarketplaceArtifacts(
      "/backoffice/marketplace/example?artifactTab=workflows",
    );

    assert(markup.includes("daily-report.workflow.js"));
    assert(markup.includes("Select a workflow"));
    assert(!markup.includes('aria-label="Workflow graph"'));
  });

  test("parses fetched workflow sources with the shared workflow graph on the client", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <MarketplaceArtifactWorkflowGraphs workflows={[workflowSource]} />
      </MemoryRouter>,
    );

    assert(markup.includes('aria-label="Workflow graph"'));
    assert(markup.includes("daily-report"));
    assert(markup.includes("send report"));
    assert(markup.includes("daily-report.workflow.js"));
  });
});

function renderMarketplaceArtifacts(initialEntry: string): string {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: <MarketplaceArtifactFiles data={artifactData} />,
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}
