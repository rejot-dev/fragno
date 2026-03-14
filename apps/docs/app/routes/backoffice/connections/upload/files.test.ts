import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUploadConfig, fetchUploadFiles } from "./data";
import { loader } from "./files";

vi.mock("@base-ui/react", () => ({
  Collapsible: {},
  Progress: {},
}));

vi.mock("@/components/backoffice", () => ({
  formatBytes: vi.fn(),
}));

vi.mock("@/fragno/upload-client", () => ({
  createUploadClient: vi.fn(() => ({
    useUploadHelpers: () => ({}),
  })),
}));

vi.mock("./data", () => ({
  fetchUploadConfig: vi.fn(),
  fetchUploadDownloadUrl: vi.fn(),
  fetchUploadFile: vi.fn(),
  fetchUploadFiles: vi.fn(),
  deleteUploadFile: vi.fn(),
}));

describe("upload files loader", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const createLoaderArgs = (url: string) =>
    ({
      request: new Request(url),
      params: { orgId: "org_123" },
      context: {} as never,
    }) as unknown as Parameters<typeof loader>[0];

  it("returns the loader-fetched config state alongside configError", async () => {
    const configState = {
      configured: true,
      defaultProvider: "r2-binding" as const,
      providers: {},
    };

    vi.mocked(fetchUploadConfig).mockResolvedValue({
      configState,
      configError: null,
    });
    vi.mocked(fetchUploadFiles).mockResolvedValue({
      files: [],
      hasNextPage: false,
      filesError: null,
    });

    const result = await loader(
      createLoaderArgs("https://example.com/backoffice/connections/upload/org_123/files"),
    );

    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({
      configState,
      configError: null,
      files: [],
      selectedNodeKind: "root",
      selectedPrefix: "",
    });
  });

  it("returns the same failed config source without fetching files", async () => {
    vi.mocked(fetchUploadConfig).mockResolvedValue({
      configState: null,
      configError: "Failed to load configuration.",
    });

    const result = await loader(
      createLoaderArgs("https://example.com/backoffice/connections/upload/org_123/files"),
    );

    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({
      configState: null,
      configError: "Failed to load configuration.",
      files: [],
      selectedNodeKind: "root",
      selectedPrefix: "",
    });
    expect(fetchUploadFiles).not.toHaveBeenCalled();
  });
});
