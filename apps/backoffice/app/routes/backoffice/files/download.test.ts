import { beforeEach, describe, expect, test, vi, assert } from "vitest";

import { createStaticFileCollection } from "@/file-collection/create-static-file-collection";

const { findBackofficeMeMock, createFilesOverviewCollectionsMock } = vi.hoisted(() => ({
  findBackofficeMeMock: vi.fn(),
  createFilesOverviewCollectionsMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({
  findBackofficeMe: findBackofficeMeMock,
}));

vi.mock("./file-collections.server", () => ({
  createFilesOverviewCollections: createFilesOverviewCollectionsMock,
}));

import { buildBackofficeLoginPath } from "../auth-navigation";
import { loader } from "./download";

const DOWNLOAD_PATH = "/backoffice/files/org/org_123/download";

describe("backoffice files download route", () => {
  beforeEach(() => {
    findBackofficeMeMock.mockReset();
    createFilesOverviewCollectionsMock.mockReset();
    findBackofficeMeMock.mockResolvedValue(createAuthMe());
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

  test("redirects anonymous users to login", async () => {
    findBackofficeMeMock.mockResolvedValue(null);
    const returnTo = `${DOWNLOAD_PATH}?path=%2Fstatic%2FSYSTEM.md`;
    const response = toResponse(await loader(createLoaderArgs(`https://example.com${returnTo}`)));

    assert(response.status === 302);
    expect(response.headers.get("Location")).toBe(
      `https://example.com${buildBackofficeLoginPath(returnTo)}`,
    );
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

  test("rejects organizations unavailable to the current user", async () => {
    findBackofficeMeMock.mockResolvedValue({ ...createAuthMe(), organizations: [] });

    await expect(
      loader(createLoaderArgs(`https://example.com${DOWNLOAD_PATH}?path=%2Fstatic%2FSYSTEM.md`)),
    ).rejects.toMatchObject({ status: 404 });
    expect(createFilesOverviewCollectionsMock).not.toHaveBeenCalled();
  });
});

const createLoaderArgs = (url: string) =>
  ({
    request: new Request(url),
    url: new URL(url),
    context: { get: () => ({ runtime: { objects: {}, config: {} } }) } as never,
    params: { scopeKind: "org", scopeId: "org_123" },
  }) as unknown as Parameters<typeof loader>[0];

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
      organization: { id: "org_123", name: "Fragno" },
      member: { organizationId: "org_123" },
    },
  ],
  activeOrganization: {
    organization: { id: "org_123", name: "Fragno" },
    member: { organizationId: "org_123" },
  },
  invitations: [],
});
