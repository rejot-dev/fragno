import { afterEach, beforeEach, describe, expect, it, vi, assert } from "vitest";

const { getAuthMeMock, createBackofficeFileSystemMock, requireBackofficeContextMock } = vi.hoisted(
  () => ({
    getAuthMeMock: vi.fn(),
    createBackofficeFileSystemMock: vi.fn(),
    requireBackofficeContextMock: vi.fn(),
  }),
);

vi.mock("@/fragno/auth/auth-server", () => ({
  getAuthMe: getAuthMeMock,
}));

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));

vi.mock("@/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/files")>();
  return {
    ...actual,
    createBackofficeFileSystem: createBackofficeFileSystemMock,
  };
});

import {
  createMasterFileSystem,
  createSystemFilesContext,
  createUnsupportedFileSystem,
  getBuiltInFileContributors,
  type FileContributor,
} from "@/files";

import { buildBackofficeLoginPath } from "../auth-navigation";
import * as filesData from "./data";
import { loader, MAX_BUFFERED_DOWNLOAD_BYTES } from "./download";

const contributors: FileContributor[] = [];

const registerFileContributor = (contributor: FileContributor): void => {
  contributors.push(contributor);
};

describe("backoffice files download route", () => {
  beforeEach(() => {
    contributors.length = 0;
    getAuthMeMock.mockReset();
    createBackofficeFileSystemMock.mockReset();
    requireBackofficeContextMock.mockReset();
    requireBackofficeContextMock.mockResolvedValue({
      actor: {
        type: "user",
        id: "user_123",
        userId: "user_123",
        organizationIds: ["org_123"],
      },
      scope: { kind: "org", orgId: "org_123" },
    });
    createBackofficeFileSystemMock.mockImplementation(() =>
      createMasterFileSystem(
        createSystemFilesContext({
          execution: {
            actor: { type: "system", id: "system" },
            scope: { kind: "org", orgId: "org_123" },
          },

          staticFileArtifacts: () => ({}),
        }),
        {
          contributors: [...getBuiltInFileContributors(), ...contributors],
        },
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redirects anonymous users to login", async () => {
    getAuthMeMock.mockResolvedValue(null);

    const response = toResponse(
      await loader(
        createLoaderArgs(
          "https://example.com/backoffice/files/org_123/download?path=%2Fstatic%2FSYSTEM.md",
        ),
      ),
    );

    assert(response.status === 302);
    expect(response.headers.get("Location")).toBe(
      `https://example.com${buildBackofficeLoginPath("/backoffice/files/org_123/download?path=%2Fstatic%2FSYSTEM.md")}`,
    );
  });

  it("downloads the selected file as an attachment", async () => {
    getAuthMeMock.mockResolvedValue(createAuthMe());

    const response = toResponse(
      await loader(
        createLoaderArgs(
          "https://example.com/backoffice/files/org_123/download?path=%2Fstatic%2FSYSTEM.md",
        ),
      ),
    );

    assert(response.status === 200);
    assert(response.headers.get("content-type") === "text/markdown; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="SYSTEM.md"',
    );
    await expect(response.text()).resolves.toContain("Backoffice");
  });

  it("streams downloads when the mounted filesystem supports it", async () => {
    getAuthMeMock.mockResolvedValue(createAuthMe());
    const readFileBuffer = vi.fn(async (_path: string) => new Uint8Array([0]));
    const readFileStream = vi.fn(
      async (_path: string) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("streamed download"));
            controller.close();
          },
        }),
    );
    registerFileContributor(
      createStreamingFileContributor({
        path: "/stream/big.bin",
        size: 17,
        readFileBuffer,
        readFileStream,
      }),
    );

    const response = toResponse(
      await loader(
        createLoaderArgs(
          "https://example.com/backoffice/files/org_123/download?path=%2Fstream%2Fbig.bin",
        ),
      ),
    );

    assert(response.status === 200);
    assert(response.headers.get("content-length") === "17");
    await expect(response.text()).resolves.toBe("streamed download");
    expect(readFileStream).toHaveBeenCalledWith("/stream/big.bin");
    expect(readFileBuffer).not.toHaveBeenCalled();
  });

  it("rejects large downloads when streaming is unsupported and buffering would exceed the guard", async () => {
    getAuthMeMock.mockResolvedValue(createAuthMe());
    const readFileBuffer = vi.fn(async (_path: string) => new Uint8Array([0]));
    registerFileContributor(
      createBufferOnlyFileContributor({
        path: "/buffered/large.bin",
        size: MAX_BUFFERED_DOWNLOAD_BYTES + 1,
        readFileBuffer,
      }),
    );

    await expect(
      loader(
        createLoaderArgs(
          "https://example.com/backoffice/files/org_123/download?path=%2Fbuffered%2Flarge.bin",
        ),
      ),
    ).rejects.toMatchObject({
      status: 413,
    });
    expect(readFileBuffer).not.toHaveBeenCalled();
  });

  it("returns 404 when the requested file does not exist", async () => {
    getAuthMeMock.mockResolvedValue(createAuthMe());

    await expect(
      loader(
        createLoaderArgs(
          "https://example.com/backoffice/files/org_123/download?path=%2Fsystem%2Fmissing.md",
        ),
      ),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("returns 404 when the file disappears between stat and read", async () => {
    getAuthMeMock.mockResolvedValue(createAuthMe());
    registerFileContributor(createDisappearingFileContributor());

    await expect(
      loader(
        createLoaderArgs(
          "https://example.com/backoffice/files/org_123/download?path=%2Fvolatile%2Fgone.txt",
        ),
      ),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("lets backend stat failures surface instead of translating them to 404", async () => {
    getAuthMeMock.mockResolvedValue(createAuthMe());
    vi.spyOn(filesData, "createBackofficeFilesFileSystem").mockResolvedValue({
      stat: vi.fn(async () => {
        throw new Error("storage backend unavailable");
      }),
    } as never);

    await expect(
      loader(
        createLoaderArgs(
          "https://example.com/backoffice/files/org_123/download?path=%2Fbroken%2Fboom.txt",
        ),
      ),
    ).rejects.toMatchObject({
      message: "storage backend unavailable",
    });
  });

  it("rejects folder downloads", async () => {
    getAuthMeMock.mockResolvedValue(createAuthMe());

    await expect(
      loader(
        createLoaderArgs(
          "https://example.com/backoffice/files/org_123/download?path=%2Fstatic%2Fskills",
        ),
      ),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

const createLoaderArgs = (url: string) =>
  ({
    request: new Request(url),
    context: { get: () => ({ runtime: { objects: {} }, env: {} }) } as never,
    params: { orgId: "org_123" },
  }) as unknown as Parameters<typeof loader>[0];

const toResponse = (result: Awaited<ReturnType<typeof loader>>): Response => {
  expect(result).toBeInstanceOf(Response);
  if (!(result instanceof Response)) {
    throw new TypeError("Expected loader to return a Response.");
  }
  return result;
};

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

const createDisappearingFileContributor = (): FileContributor => ({
  id: "volatile-download-test",
  kind: "custom",
  mountPoint: "/volatile",
  title: "Volatile",
  readOnly: true,
  persistence: "session",
  ...createUnsupportedFileSystem((operation, path) => new Error(`${operation} ${path}`)),
  async stat(path) {
    if (path !== "/volatile/gone.txt") {
      throw new Error("Path not found.");
    }

    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o644,
      size: 4,
      mtime: new Date(0),
    };
  },
  async readFileBuffer() {
    throw new Error("File not found.");
  },
});

const createStreamingFileContributor = ({
  path,
  size,
  readFileBuffer,
  readFileStream,
}: {
  path: string;
  size: number;
  readFileBuffer: (path: string) => Promise<Uint8Array>;
  readFileStream: (path: string) => Promise<ReadableStream<Uint8Array>>;
}): FileContributor => ({
  id: `streaming-${path}`,
  kind: "custom",
  mountPoint: `/${path.split("/").filter(Boolean)[0]}`,
  title: "Streaming",
  readOnly: true,
  persistence: "session",
  ...createUnsupportedFileSystem((operation, path) => new Error(`${operation} ${path}`)),
  async stat(candidatePath) {
    if (candidatePath !== path) {
      throw new Error("Path not found.");
    }

    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o644,
      size,
      mtime: new Date(0),
    };
  },
  readFileBuffer,
  readFileStream,
});

const createBufferOnlyFileContributor = ({
  path,
  size,
  readFileBuffer,
}: {
  path: string;
  size: number;
  readFileBuffer: (path: string) => Promise<Uint8Array>;
}): FileContributor => ({
  id: `buffered-${path}`,
  kind: "custom",
  mountPoint: `/${path.split("/").filter(Boolean)[0]}`,
  title: "Buffered",
  readOnly: true,
  persistence: "session",
  ...createUnsupportedFileSystem((operation, path) => new Error(`${operation} ${path}`)),
  async stat(candidatePath) {
    if (candidatePath !== path) {
      throw new Error("Path not found.");
    }

    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o644,
      size,
      mtime: new Date(0),
    };
  },
  readFileBuffer,
});
