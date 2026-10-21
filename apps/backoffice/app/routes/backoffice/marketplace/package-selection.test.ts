import { assert, beforeEach, describe, test, vi } from "vitest";

const { loadMarketplacePackageFileMock } = vi.hoisted(() => ({
  loadMarketplacePackageFileMock: vi.fn(),
}));

vi.mock("./package-file.server", () => ({
  loadMarketplacePackageFile: loadMarketplacePackageFileMock,
}));

import { loader, shouldRevalidate } from "./package-selection";

const workflowPath = "/package/1.0.0/automations/daily-report.workflow.js";

beforeEach(() => {
  loadMarketplacePackageFileMock.mockReset();
});

describe("marketplace package selection loader", () => {
  test("loads the workflow selected in the URL", async () => {
    loadMarketplacePackageFileMock.mockResolvedValueOnce(
      new Response("defineWorkflow({ name: 'daily-report' }, async () => {});"),
    );
    const url = new URL(
      `https://example.test/backoffice/marketplace/example?packageTab=workflows&packagePath=${encodeURIComponent(workflowPath)}&packageContent=text`,
    );

    const result = await loader({ request: new Request(url), url } as never);

    assert.deepEqual(result, {
      selectedContent: {
        path: workflowPath,
        text: "defineWorkflow({ name: 'daily-report' }, async () => {});",
      },
    });
    assert(loadMarketplacePackageFileMock.mock.calls.length === 1);
  });

  test("loads a text file selected in the files tab", async () => {
    const filePath = "/package/1.0.0/src/index.ts";
    loadMarketplacePackageFileMock.mockResolvedValueOnce(new Response("export const value = 1;"));
    const url = new URL(
      `https://example.test/backoffice/marketplace/example?packageTab=files&packagePath=${encodeURIComponent(filePath)}&packageContent=text`,
    );

    const result = await loader({ request: new Request(url), url } as never);

    assert.deepEqual(result, {
      selectedContent: { path: filePath, text: "export const value = 1;" },
    });
  });

  test("does not load content without a selected file", async () => {
    const url = new URL("https://example.test/backoffice/marketplace/example?packageTab=workflows");

    const result = await loader({ request: new Request(url), url } as never);

    assert.deepEqual(result, { selectedContent: null });
    assert(loadMarketplacePackageFileMock.mock.calls.length === 0);
  });

  test("returns no content when the selected file does not exist", async () => {
    loadMarketplacePackageFileMock.mockResolvedValueOnce(
      new Response("Marketplace file is unavailable.", { status: 404 }),
    );
    const url = new URL(
      `https://example.test/backoffice/marketplace/example?packageTab=workflows&packagePath=${encodeURIComponent(workflowPath)}&packageContent=text`,
    );

    const result = await loader({ request: new Request(url), url } as never);

    assert.deepEqual(result, { selectedContent: null });
  });
});

describe("marketplace package selection revalidation", () => {
  test("revalidates when the package path changes", () => {
    assert(
      shouldRevalidate({
        currentUrl: new URL(
          "https://example.test/marketplace/example?packageTab=workflows&packagePath=first",
        ),
        nextUrl: new URL(
          "https://example.test/marketplace/example?packageTab=workflows&packagePath=second",
        ),
        defaultShouldRevalidate: true,
      } as never),
    );
  });

  test("revalidates when text content is requested", () => {
    assert(
      shouldRevalidate({
        currentUrl: new URL(
          "https://example.test/marketplace/example?packageTab=files&packagePath=first",
        ),
        nextUrl: new URL(
          "https://example.test/marketplace/example?packageTab=files&packagePath=first&packageContent=text",
        ),
        defaultShouldRevalidate: true,
      } as never),
    );
  });

  test("skips revalidation for unrelated search parameters", () => {
    assert(
      !shouldRevalidate({
        currentUrl: new URL(
          "https://example.test/marketplace/example?packageTab=workflows&packagePath=first",
        ),
        nextUrl: new URL(
          "https://example.test/marketplace/example?packageTab=workflows&packagePath=first&published=1.0.0",
        ),
        defaultShouldRevalidate: true,
      } as never),
    );
  });
});
