import { beforeEach, describe, expect, test, vi, assert } from "vitest";

import { RouterContextProvider } from "react-router";

import { createStaticFileCollection } from "@/file-collection/create-static-file-collection";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { provideBackofficeShellRequest } from "@/layouts/backoffice-layout.test-support";

const { createFilesOverviewCollectionsMock } = vi.hoisted(() => ({
  createFilesOverviewCollectionsMock: vi.fn(),
}));

vi.mock("./file-collections.server", () => ({
  createFilesOverviewCollections: createFilesOverviewCollectionsMock,
}));

import { loader } from "./download";

const DOWNLOAD_PATH = "/backoffice/files/org/fragno/download";

describe("backoffice files download route", () => {
  beforeEach(() => {
    createFilesOverviewCollectionsMock.mockReset();
    createFilesOverviewCollectionsMock.mockResolvedValue([
      {
        rootPath: "/static",
        rootTitle: "Static",
        collection: createStaticFileCollection({
          "SYSTEM.md": "Static guidance",
          "images/logo.png": new Uint8Array([1, 2, 3]),
        }),
      },
    ]);
  });

  test("streams a selected collection file as an attachment", async () => {
    const response = toResponse(
      await loader(
        createLoaderArgs(`https://example.com${DOWNLOAD_PATH}?path=%2Fstatic%2FSYSTEM.md`),
      ),
    );

    assert(response.status === 200);
    assert(response.headers.get("content-type") === "text/markdown");
    assert(response.headers.get("content-length") === String("Static guidance".length));
    expect(response.headers.get("content-disposition")).toContain('filename="SYSTEM.md"');
    assert((await response.text()) === "Static guidance");
  });

  test("serves images inline only when requested and keeps other files as attachments", async () => {
    const inlineImage = toResponse(
      await loader(
        createLoaderArgs(
          `https://example.com${DOWNLOAD_PATH}?path=%2Fstatic%2Fimages%2Flogo.png&disposition=inline`,
        ),
      ),
    );
    assert(inlineImage.headers.get("content-type") === "image/png");
    expect(inlineImage.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(inlineImage.headers.get("content-security-policy")).toContain("sandbox");

    const inlineText = toResponse(
      await loader(
        createLoaderArgs(
          `https://example.com${DOWNLOAD_PATH}?path=%2Fstatic%2FSYSTEM.md&disposition=inline`,
        ),
      ),
    );
    expect(inlineText.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  test("returns not found for roots, directories, and unknown files", async () => {
    await expect(
      loader(createLoaderArgs(`https://example.com${DOWNLOAD_PATH}?path=%2Fstatic`)),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      loader(createLoaderArgs(`https://example.com${DOWNLOAD_PATH}?path=%2Fstatic%2Fimages%2F`)),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      loader(createLoaderArgs(`https://example.com${DOWNLOAD_PATH}?path=%2Fstatic%2Fmissing.txt`)),
    ).rejects.toMatchObject({ status: 404 });
  });
});

const fragno = { id: "org_123", slug: "fragno", name: "Fragno" };

const createLoaderArgs = (url: string) => {
  const context = new RouterContextProvider();
  provideBackofficeShellRequest(context, {
    me: createAuthMe() as unknown as BackofficeMeData,
    routeScope: { kind: "org", organization: fragno } as never,
  });
  return {
    request: new Request(url),
    url: new URL(url),
    context,
    params: { scopeKind: "org", scopeId: "fragno" },
  } as unknown as Parameters<typeof loader>[0];
};

function toResponse(result: Awaited<ReturnType<typeof loader>>): Response {
  expect(result).toBeInstanceOf(Response);
  if (!(result instanceof Response)) {
    throw new TypeError("Expected loader to return a Response.");
  }
  return result;
}

const createAuthMe = () => ({
  user: { id: "user_123", email: "dev@fragno.test", role: "admin" },
  organizations: [
    {
      organization: { id: "org_123", slug: "fragno", name: "Fragno" },
      member: { organizationId: "org_123" },
    },
  ],
  activeOrganization: {
    organization: { id: "org_123", slug: "fragno", name: "Fragno" },
    member: { organizationId: "org_123" },
  },
});
