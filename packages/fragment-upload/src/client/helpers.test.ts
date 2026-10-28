import { describe, expect, it, assert, vi } from "vitest";

import { createUploadHelpers } from "./helpers";

const jsonResponse = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

const readStream = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
    }
  }
  return total;
};

const getHeaderValue = (headers: HeadersInit | undefined, name: string): string | undefined => {
  if (!headers) {
    return undefined;
  }
  const lookup = name.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(lookup) ?? headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const entry = headers.find(([key]) => key.toLowerCase() === lookup);
    return entry?.[1];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lookup) {
      return value as string;
    }
  }
  return undefined;
};

const byKeyContentPath = (fileKey: string) =>
  `/files/by-key/content?${new URLSearchParams({ key: fileKey }).toString()}`;

const uploadContentPath = (uploadId: string) => `/uploads/${uploadId}/content`;

describe("upload client helpers", () => {
  it("streams upload content and reports progress", async () => {
    const progress: number[] = [];

    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/uploads")) {
        const body = JSON.parse(_init?.body as string);
        assert(body.fileKey === "files.assets.banner");
        assert(body.contentType === "text/plain");
        return jsonResponse({
          uploadId: "proxy-1",
          fileKey: "files.assets.banner",
          status: "created",
          expiresAt: new Date().toISOString(),
        });
      }

      if (url.endsWith(uploadContentPath("proxy-1"))) {
        const init = _init as (RequestInit & { duplex?: string }) | undefined;
        assert(init?.duplex === "half");
        assert(getHeaderValue(init?.headers, "content-type") === "application/octet-stream");
        const totalBytes = await readStream(_init?.body as ReadableStream<Uint8Array>);
        expect(totalBytes).toBe(5);
        return jsonResponse({
          kind: "published",
          file: { fileKey: "files.assets.banner", status: "ready" },
        });
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `http://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    const file = new Blob(["hello"], { type: "text/plain" });

    const result = await helpers.createUploadAndTransfer(file, {
      fileKey: "files.assets.banner",
      onProgress: (value) => progress.push(value.bytesUploaded),
    });

    assert(result.kind === "published");
    assert(result.file.fileKey === "files.assets.banner");
    assert(progress[progress.length - 1] === 5);
  });

  it("persists batch publication intent and returns a prepared write", async () => {
    const expiresAt = new Date("2027-01-01T00:00:00.000Z").toISOString();

    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/uploads")) {
        const body = JSON.parse(init?.body as string);
        assert(body.publicationMode === "batch");
        return jsonResponse({
          uploadId: "prepared-proxy",
          fileKey: "files/prepared.txt",
          status: "created",
          publicationMode: "batch",
          expiresAt,
        });
      }

      if (url.endsWith(uploadContentPath("prepared-proxy"))) {
        return jsonResponse({
          kind: "prepared",
          write: {
            uploadId: "prepared-proxy",
            fileKey: "files/prepared.txt",
            sizeBytes: 8,
            contentType: "text/plain",
            checksum: null,
            expiresAt,
          },
        });
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `http://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    const result = await helpers.createUploadAndTransfer(new Blob(["prepared"]), {
      fileKey: "files/prepared.txt",
      publicationMode: "batch",
    });

    assert(result.kind === "prepared");
    expect(result.write).toMatchObject({
      uploadId: "prepared-proxy",
      fileKey: "files/prepared.txt",
    });
  });

  it("falls back to buffered uploads when streaming fails", async () => {
    const progress: number[] = [];
    let attempts = 0;

    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/uploads")) {
        const body = JSON.parse(_init?.body as string);
        assert(body.fileKey === "files.assets.logo");
        return jsonResponse({
          uploadId: "proxy-2",
          fileKey: "files.assets.logo",
          status: "created",
          expiresAt: new Date().toISOString(),
        });
      }

      if (url.endsWith(uploadContentPath("proxy-2"))) {
        attempts += 1;
        if (attempts === 1) {
          throw new TypeError("Failed to fetch");
        }
        const init = _init as RequestInit & { duplex?: string };
        expect(init.duplex).toBeUndefined();
        expect(init.body).toBeInstanceOf(Blob);
        return jsonResponse({
          kind: "published",
          file: { fileKey: "files.assets.logo", status: "ready" },
        });
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `http://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    const file = new Blob(["hello"], { type: "text/plain" });

    const result = await helpers.createUploadAndTransfer(file, {
      fileKey: "files.assets.logo",
      onProgress: (value) => progress.push(value.bytesUploaded),
    });

    assert(result.kind === "published");
    assert(result.file.fileKey === "files.assets.logo");
    assert(progress[progress.length - 1] === 5);
  });

  it("throws actionable guidance when content transport fails for both attempts", async () => {
    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/uploads")) {
        const body = JSON.parse(_init?.body as string);
        assert(body.fileKey === "files.assets.fail");
        return jsonResponse({
          uploadId: "proxy-3",
          fileKey: "files.assets.fail",
          status: "created",
          expiresAt: new Date().toISOString(),
        });
      }

      if (url.endsWith(uploadContentPath("proxy-3"))) {
        throw new TypeError("ALPN negotiation failed");
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `http://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    const file = new Blob(["hello"], { type: "text/plain" });

    await expect(
      helpers.createUploadAndTransfer(file, {
        fileKey: "files.assets.fail",
      }),
    ).rejects.toThrow(/Upload to '.*' failed/);

    await expect(
      helpers.createUploadAndTransfer(file, {
        fileKey: "files.assets.fail",
      }),
    ).rejects.toThrow(/\/uploads\/:uploadId\/content/);
  });

  it("fails fast when the content endpoint uses an unsupported protocol", async () => {
    let contentEndpointCalled = false;

    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/uploads")) {
        const body = JSON.parse(_init?.body as string);
        assert(body.fileKey === "files.assets.protocol");
        return jsonResponse({
          uploadId: "proxy-4",
          fileKey: "files.assets.protocol",
          status: "created",
          expiresAt: new Date().toISOString(),
        });
      }

      if (url.endsWith(uploadContentPath("proxy-4"))) {
        contentEndpointCalled = true;
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `ws://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    const file = new Blob(["hello"], { type: "text/plain" });

    await expect(
      helpers.createUploadAndTransfer(file, {
        fileKey: "files.assets.protocol",
      }),
    ).rejects.toThrow(/must use http:\/\/ or https:\/\//);

    assert(!contentEndpointCalled);
  });

  it("throws actionable context when content download request fails", async () => {
    const fileKey = "files.sample.download-fail";
    const contentPath = byKeyContentPath(fileKey);
    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith(contentPath)) {
        throw new TypeError("Failed to fetch");
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `https://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    await expect(helpers.downloadFile(fileKey)).rejects.toThrow(/\/files\/by-key\/content/);
  });

  it.each([0, -1, Number.NaN])(
    "rejects an invalid search hydration byte budget of %s",
    async (maxBytes) => {
      const fetcher = vi.fn<typeof fetch>();
      const helpers = createUploadHelpers({
        buildUrl: (path) => `https://local${path}`,
        fetcher,
      });

      await expect(
        helpers.hydrateSearchMatches(["workspace/src/workflows.ts"], ["createWorkflow"], {
          excludedTerms: [],
          maxBytes,
        }),
      ).rejects.toThrow("Search byte budget must be a positive number");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("requires callers to specify a file key when creating uploads", async () => {
    const helpers = createUploadHelpers({
      buildUrl: (path) => `https://local${path}`,
      fetcher: (async () => new Response(null, { status: 500 })) as typeof fetch,
    });

    await expect(helpers.createUploadAndTransfer(new Blob(["data"]), {} as never)).rejects.toThrow(
      /File key is required/,
    );
  });

  it("sends file edits to the server in one request", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: input.toString(), init });
      return jsonResponse({
        edits: [
          {
            fileKey: "src/config.ts",
            changed: true,
            content: "export const enabled = true;",
            diff: "--- a/src/config.ts",
          },
        ],
        totalChanged: 1,
      });
    };
    const helpers = createUploadHelpers({
      buildUrl: (path) => `https://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    const input = {
      edits: [
        {
          kind: "replace" as const,
          fileKey: "src/config.ts",
          search: "false",
          replacement: "true",
        },
      ],
    };
    const result = await helpers.applyEdits(input);

    assert(result.totalChanged === 1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://local/files/apply-edits",
      init: { method: "POST" },
    });
    expect(JSON.parse(requests[0].init?.body as string)).toEqual(input);
  });
});
