// @vitest-environment happy-dom

import { afterEach, assert, describe, test } from "vitest";

import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MarketplaceArtifactFiles } from "./artifact-files";
import type { MarketplaceArtifactExplorerData } from "./artifact-files-model";

const workflowPath = "/artifact/1.0.0/automations/daily-report.workflow.js";
const workflowSource = `defineWorkflow({ name: "daily-report" }, async (_event, step) => {
  await step.do("send report", async () => {});
});`;

const data: MarketplaceArtifactExplorerData = {
  state: "ready",
  tree: [],
  selectedVersion: "1.0.0",
  defaultPath: "/artifact/1.0.0/",
  detailsByPath: {
    [workflowPath]: {
      node: {
        kind: "file",
        path: workflowPath,
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
  overviewPath: null,
};

afterEach(cleanup);

describe("Marketplace artifact lazy content", () => {
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

  test("renders text file content selected by the route loader", async () => {
    const fileData: MarketplaceArtifactExplorerData = {
      ...data,
      tree: [
        {
          kind: "root",
          path: "/artifact",
          name: "artifact",
          title: "Package contents",
          mountPoint: "/artifact",
          mountTitle: "Package contents",
          mountKind: "custom",
          readOnly: true,
          persistence: "persistent",
          children: [data.detailsByPath[workflowPath]!.node],
        },
      ],
    };
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
    fireEvent.click(screen.getByRole("link", { name: "daily-report.workflow.js" }));

    await waitFor(() => {
      const search = new URLSearchParams(router.state.location.search);
      assert(search.get("artifactPath") === workflowPath);
      assert(search.get("artifactContent") === "text");
    });
    await screen.findByText(/defineWorkflow/);
  });

  test("clears a fetched workflow when the artifact version changes", async () => {
    const secondWorkflowPath = "/artifact/2.0.0/automations/weekly-report.workflow.js";
    const secondVersionData: MarketplaceArtifactExplorerData = {
      ...data,
      selectedVersion: "2.0.0",
      defaultPath: "/artifact/2.0.0/",
      detailsByPath: {
        [secondWorkflowPath]: {
          ...data.detailsByPath[workflowPath]!,
          node: {
            ...data.detailsByPath[workflowPath]!.node,
            path: secondWorkflowPath,
            name: "weekly-report.workflow.js",
            title: "weekly-report.workflow.js",
          },
        },
      },
    };
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
