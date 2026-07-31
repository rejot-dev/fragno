import { assert, beforeEach, describe, test, vi } from "vitest";

const { loadMarketplaceArtifactFileMock } = vi.hoisted(() => ({
  loadMarketplaceArtifactFileMock: vi.fn(),
}));

vi.mock("./artifact-file.server", () => ({
  loadMarketplaceArtifactFile: loadMarketplaceArtifactFileMock,
}));

import { loader, shouldRevalidate } from "./artifact-selection";

const workflowPath = "/artifact/1.0.0/automations/daily-report.workflow.js";

beforeEach(() => {
  loadMarketplaceArtifactFileMock.mockReset();
});

describe("marketplace artifact selection loader", () => {
  test("loads the workflow selected in the URL", async () => {
    loadMarketplaceArtifactFileMock.mockResolvedValueOnce(
      new Response("defineWorkflow({ name: 'daily-report' }, async () => {});"),
    );
    const url = new URL(
      `https://example.test/backoffice/marketplace/example?artifactTab=workflows&artifactPath=${encodeURIComponent(workflowPath)}&artifactContent=text`,
    );

    const result = await loader({ request: new Request(url), url } as never);

    assert.deepEqual(result, {
      selectedContent: {
        path: workflowPath,
        text: "defineWorkflow({ name: 'daily-report' }, async () => {});",
      },
    });
    assert(loadMarketplaceArtifactFileMock.mock.calls.length === 1);
  });

  test("loads a text file selected in the files tab", async () => {
    const filePath = "/artifact/1.0.0/src/index.ts";
    loadMarketplaceArtifactFileMock.mockResolvedValueOnce(new Response("export const value = 1;"));
    const url = new URL(
      `https://example.test/backoffice/marketplace/example?artifactTab=files&artifactPath=${encodeURIComponent(filePath)}&artifactContent=text`,
    );

    const result = await loader({ request: new Request(url), url } as never);

    assert.deepEqual(result, {
      selectedContent: { path: filePath, text: "export const value = 1;" },
    });
  });

  test("does not load content without a selected file", async () => {
    const url = new URL(
      "https://example.test/backoffice/marketplace/example?artifactTab=workflows",
    );

    const result = await loader({ request: new Request(url), url } as never);

    assert.deepEqual(result, { selectedContent: null });
    assert(loadMarketplaceArtifactFileMock.mock.calls.length === 0);
  });

  test("returns no content when the selected file does not exist", async () => {
    loadMarketplaceArtifactFileMock.mockResolvedValueOnce(
      new Response("Marketplace file is unavailable.", { status: 404 }),
    );
    const url = new URL(
      `https://example.test/backoffice/marketplace/example?artifactTab=workflows&artifactPath=${encodeURIComponent(workflowPath)}&artifactContent=text`,
    );

    const result = await loader({ request: new Request(url), url } as never);

    assert.deepEqual(result, { selectedContent: null });
  });
});

describe("marketplace artifact selection revalidation", () => {
  test("revalidates when the artifact path changes", () => {
    assert(
      shouldRevalidate({
        currentUrl: new URL(
          "https://example.test/marketplace/example?artifactTab=workflows&artifactPath=first",
        ),
        nextUrl: new URL(
          "https://example.test/marketplace/example?artifactTab=workflows&artifactPath=second",
        ),
        defaultShouldRevalidate: true,
      } as never),
    );
  });

  test("revalidates when text content is requested", () => {
    assert(
      shouldRevalidate({
        currentUrl: new URL(
          "https://example.test/marketplace/example?artifactTab=files&artifactPath=first",
        ),
        nextUrl: new URL(
          "https://example.test/marketplace/example?artifactTab=files&artifactPath=first&artifactContent=text",
        ),
        defaultShouldRevalidate: true,
      } as never),
    );
  });

  test("skips revalidation for unrelated search parameters", () => {
    assert(
      !shouldRevalidate({
        currentUrl: new URL(
          "https://example.test/marketplace/example?artifactTab=workflows&artifactPath=first",
        ),
        nextUrl: new URL(
          "https://example.test/marketplace/example?artifactTab=workflows&artifactPath=first&published=1.0.0",
        ),
        defaultShouldRevalidate: true,
      } as never),
    );
  });
});
