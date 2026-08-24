// @vitest-environment happy-dom

import { afterEach, assert, describe, test } from "vitest";

import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { createFileTree } from "@/file-collection/create-file-tree";

import { MarketplaceArtifactFiles } from "./artifact-files";
import type { MarketplaceArtifactExplorerData } from "./artifact-files-model";

const workflowPath = "/artifact/1.0.0/automations/daily-report.workflow.js";
const workflowSource = `defineWorkflow({ name: "daily-report" }, async (_event, step) => {
  await step.do("send report", async () => {});
});`;

const data: MarketplaceArtifactExplorerData = {
  state: "ready",
  fileTree: createFileTree([
    {
      kind: "file",
      path: "1.0.0/automations/daily-report.workflow.js",
      sizeBytes: workflowSource.length,
      contentType: "text/javascript",
      updatedAt: null,
      metadata: null,
    },
  ]),
  selectedVersion: "1.0.0",
};
const secondVersionData: MarketplaceArtifactExplorerData = {
  state: "ready",
  fileTree: createFileTree([
    {
      kind: "file",
      path: "2.0.0/automations/weekly-report.workflow.js",
      sizeBytes: workflowSource.length,
      contentType: "text/javascript",
      updatedAt: null,
      metadata: null,
    },
  ]),
  selectedVersion: "2.0.0",
};
const overviewData: MarketplaceArtifactExplorerData = {
  state: "ready",
  fileTree: createFileTree([
    {
      kind: "file",
      path: "README.md",
      sizeBytes: 25,
      contentType: "text/markdown",
      updatedAt: null,
      metadata: null,
    },
  ]),
  selectedVersion: "1.0.0",
};

afterEach(cleanup);

describe("Marketplace artifact lazy content", () => {
  test("loads the overview by default", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/backoffice/marketplace/example",
          element: <MarketplaceArtifactFiles data={overviewData} />,
        },
        {
          path: "/backoffice/marketplace/example/artifact-file",
          loader: () => "# Package overview\n\nReady to install.",
        },
      ],
      { initialEntries: ["/backoffice/marketplace/example"] },
    );

    render(<RouterProvider router={router} />);

    await screen.findByRole("heading", { name: "Package overview" });
    screen.getByText("Ready to install.");
    assert(router.state.location.search === "");
  });

  test("stores the selected workflow in the URL", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: <MarketplaceArtifactFiles data={data} />,
        },
      ],
      { initialEntries: ["/backoffice/marketplace/example?artifactTab=workflows"] },
    );

    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole("tab", { name: "daily-report.workflow.js" }));

    await waitFor(() => {
      const search = new URLSearchParams(router.state.location.search);
      assert(search.get("artifactPath") === workflowPath);
      assert(search.get("artifactContent") === "text");
    });
  });

  test("renders a workflow selected by the route loader", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <MarketplaceArtifactFiles
              data={data}
              selectedContent={{ path: workflowPath, text: workflowSource }}
            />
          ),
        },
      ],
      {
        initialEntries: [
          `/backoffice/marketplace/example?artifactTab=workflows&artifactPath=${encodeURIComponent(workflowPath)}&artifactContent=text`,
        ],
      },
    );

    render(<RouterProvider router={router} />);

    await screen.findByLabelText("Workflow graph");
    assert(
      screen
        .getByRole("tab", { name: "daily-report.workflow.js" })
        .getAttribute("aria-selected") === "true",
    );
  });

  test("renders workflow files as workflow graphs in the Files tab", async () => {
    const fileData: MarketplaceArtifactExplorerData = data;
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <MarketplaceArtifactFiles
              data={fileData}
              selectedContent={{ path: workflowPath, text: workflowSource }}
            />
          ),
        },
      ],
      { initialEntries: ["/backoffice/marketplace/example?artifactTab=files"] },
    );

    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole("link", { name: "1.0.0" }));
    fireEvent.click(await screen.findByRole("link", { name: "automations" }));
    fireEvent.click(await screen.findByRole("link", { name: "daily-report.workflow.js" }));

    await waitFor(() => {
      const search = new URLSearchParams(router.state.location.search);
      assert(search.get("artifactPath") === workflowPath);
      assert(search.get("artifactContent") === "text");
    });
    await screen.findByLabelText("Workflow graph");
  });

  test("clears a fetched workflow when the artifact version changes", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: <VersionHarness first={data} second={secondVersionData} />,
        },
      ],
      { initialEntries: ["/backoffice/marketplace/example?artifactTab=workflows"] },
    );

    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole("tab", { name: "daily-report.workflow.js" }));
    await screen.findByLabelText("Workflow graph");

    fireEvent.click(screen.getByRole("button", { name: "Show version 2" }));

    await screen.findByRole("tab", { name: "weekly-report.workflow.js" });
    assert(screen.queryByLabelText("Workflow graph") === null);
    screen.getByText("Select a workflow");
  });

  test("preserves the file tree scroll position when the artifact version changes", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: <VersionHarness first={data} second={secondVersionData} />,
        },
      ],
      { initialEntries: ["/backoffice/marketplace/example?artifactTab=files"] },
    );

    render(<RouterProvider router={router} />);
    const fileTree = screen.getByRole("navigation", {
      name: "Marketplace artifact files",
    }).parentElement;
    assert(fileTree);
    fileTree.scrollTop = 120;

    fireEvent.click(screen.getByRole("button", { name: "Show version 2" }));

    await screen.findByRole("link", { name: "2.0.0" });
    const updatedFileTree = screen.getByRole("navigation", {
      name: "Marketplace artifact files",
    }).parentElement;
    assert(updatedFileTree === fileTree);
    assert(updatedFileTree.scrollTop === 120);
  });
});

function VersionHarness({
  first,
  second,
}: {
  first: MarketplaceArtifactExplorerData;
  second: MarketplaceArtifactExplorerData;
}) {
  const [showSecond, setShowSecond] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setShowSecond(true)}>
        Show version 2
      </button>
      <MarketplaceArtifactFiles
        data={showSecond ? second : first}
        selectedContent={showSecond ? null : { path: workflowPath, text: workflowSource }}
      />
    </>
  );
}
