import { describe, expect, it } from "vitest";
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

const TEST_PROVIDER = "filesystem";

const byKeyDownloadUrlPath = (provider: string, fileKey: string) =>
  `/files/by-key/download-url?${new URLSearchParams({ provider, key: fileKey }).toString()}`;

const byKeyContentPath = (provider: string, fileKey: string) =>
  `/files/by-key/content?${new URLSearchParams({ provider, key: fileKey }).toString()}`;

const uploadRoutePath = (uploadId: string, suffix = "") =>
  `/uploads/${uploadId}${suffix}?${new URLSearchParams({ provider: TEST_PROVIDER }).toString()}`;

describe("upload client helpers", () => {
  it("splits multipart uploads, tracks progress, and completes", async () => {
    const progress: number[] = [];
    const calls: string[] = [];

    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(`${_init?.method ?? "GET"} ${url}`);

      if (url.endsWith("/uploads")) {
        const body = JSON.parse(_init?.body as string);
        expect(body.provider).toBe(TEST_PROVIDER);
        expect(body.fileKey).toBe("files.users.1.avatar");
        return jsonResponse({
          uploadId: "123",
          fileKey: "files.users.1.avatar",
          provider: TEST_PROVIDER,
          status: "created",
          strategy: "direct-multipart",
          expiresAt: new Date().toISOString(),
          upload: {
            mode: "multipart",
            transport: "direct",
            partSizeBytes: 4,
            maxParts: 10,
            statusEndpoint: uploadRoutePath("123"),
            progressEndpoint: uploadRoutePath("123", "/progress"),
            partsEndpoint: uploadRoutePath("123", "/parts"),
            partsCompleteEndpoint: uploadRoutePath("123", "/parts/complete"),
            completeEndpoint: uploadRoutePath("123", "/complete"),
            abortEndpoint: uploadRoutePath("123", "/abort"),
          },
        });
      }

      if (url.endsWith(uploadRoutePath("123", "/parts"))) {
        const body = JSON.parse(_init?.body as string);
        expect(body.partNumbers).toEqual([1, 2, 3]);
        return jsonResponse({
          parts: [
            { partNumber: 1, url: "https://storage.local/part-1" },
            { partNumber: 2, url: "https://storage.local/part-2" },
            { partNumber: 3, url: "https://storage.local/part-3" },
          ],
        });
      }

      if (url.endsWith(uploadRoutePath("123", "/progress"))) {
        return jsonResponse({ bytesUploaded: 0, partsUploaded: 0 });
      }

      if (url.endsWith(uploadRoutePath("123", "/parts/complete"))) {
        const body = JSON.parse(_init?.body as string);
        expect(body.parts).toEqual([
          { partNumber: 1, etag: "etag-1", sizeBytes: 4 },
          { partNumber: 2, etag: "etag-2", sizeBytes: 4 },
          { partNumber: 3, etag: "etag-3", sizeBytes: 2 },
        ]);
        return jsonResponse({ bytesUploaded: 10, partsUploaded: 3 });
      }

      if (url.endsWith(uploadRoutePath("123", "/complete"))) {
        const body = JSON.parse(_init?.body as string);
        expect(body.parts).toEqual([
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 2, etag: "etag-2" },
          { partNumber: 3, etag: "etag-3" },
        ]);
        return jsonResponse({ fileKey: "files.users.1.avatar", status: "ready" });
      }

      if (url.startsWith("https://storage.local/part-")) {
        const partNumber = Number(url.split("-").pop());
        return new Response(null, {
          status: 200,
          headers: { ETag: `etag-${partNumber}` },
        });
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `http://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    const file = new Blob(["abcdefghij"], { type: "text/plain" });

    const result = await helpers.createUploadAndTransfer(file, {
      provider: TEST_PROVIDER,
      fileKey: "files.users.1.avatar",
      onProgress: (value) => progress.push(value.bytesUploaded),
    });

    expect(result.file.fileKey).toBe("files.users.1.avatar");
    expect(progress).toEqual([4, 8, 10]);
    expect(calls).toContain(`POST http://local${uploadRoutePath("123", "/progress")}`);
    expect(calls).toContain(`POST http://local${uploadRoutePath("123", "/parts")}`);
    expect(calls).toContain(`POST http://local${uploadRoutePath("123", "/parts/complete")}`);
    expect(calls).toContain(`POST http://local${uploadRoutePath("123", "/complete")}`);
  });

  it("streams proxy uploads and reports progress", async () => {
    const progress: number[] = [];

    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/uploads")) {
        const body = JSON.parse(_init?.body as string);
        expect(body.provider).toBe(TEST_PROVIDER);
        expect(body.fileKey).toBe("files.assets.banner");
        expect(body.contentType).toBe("text/plain");
        return jsonResponse({
          uploadId: "proxy-1",
          fileKey: "files.assets.banner",
          provider: TEST_PROVIDER,
          status: "created",
          strategy: "proxy",
          expiresAt: new Date().toISOString(),
          upload: {
            mode: "single",
            transport: "proxy",
            statusEndpoint: uploadRoutePath("proxy-1"),
            progressEndpoint: uploadRoutePath("proxy-1", "/progress"),
            completeEndpoint: uploadRoutePath("proxy-1", "/complete"),
            abortEndpoint: uploadRoutePath("proxy-1", "/abort"),
            contentEndpoint: uploadRoutePath("proxy-1", "/content"),
          },
        });
      }

      if (url.endsWith(uploadRoutePath("proxy-1", "/content"))) {
        const init = _init as (RequestInit & { duplex?: string }) | undefined;
        expect(init?.duplex).toBe("half");
        expect(getHeaderValue(init?.headers, "content-type")).toBe("application/octet-stream");
        const totalBytes = await readStream(_init?.body as ReadableStream<Uint8Array>);
        expect(totalBytes).toBe(5);
        return jsonResponse({ fileKey: "files.assets.banner", status: "ready" });
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `http://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    const file = new Blob(["hello"], { type: "text/plain" });

    const result = await helpers.createUploadAndTransfer(file, {
      provider: TEST_PROVIDER,
      fileKey: "files.assets.banner",
      onProgress: (value) => progress.push(value.bytesUploaded),
    });

    expect(result.file.fileKey).toBe("files.assets.banner");
    expect(progress[progress.length - 1]).toBe(5);
  });

  it("returns file metadata date fields as strings", async () => {
    const now = new Date("2024-01-01T12:00:00.000Z").toISOString();
    const calls: string[] = [];

    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(`${_init?.method ?? "GET"} ${url}`);

      if (url.endsWith("/uploads")) {
        const body = JSON.parse(_init?.body as string);
        expect(body.provider).toBe(TEST_PROVIDER);
        expect(body.fileKey).toBe("files.sample.date");
        return jsonResponse({
          uploadId: "single-1",
          fileKey: "files.sample.date",
          provider: TEST_PROVIDER,
          status: "created",
          strategy: "direct-single",
          expiresAt: new Date().toISOString(),
          upload: {
            mode: "single",
            transport: "direct",
            uploadUrl: "https://storage.local/upload",
            statusEndpoint: uploadRoutePath("single-1"),
            progressEndpoint: uploadRoutePath("single-1", "/progress"),
            completeEndpoint: uploadRoutePath("single-1", "/complete"),
            abortEndpoint: uploadRoutePath("single-1", "/abort"),
          },
        });
      }

      if (url === "https://storage.local/upload") {
        return new Response(null, { status: 200 });
      }

      if (url.endsWith(uploadRoutePath("single-1", "/progress"))) {
        return jsonResponse({ bytesUploaded: 0, partsUploaded: 0 });
      }

      if (url.endsWith(uploadRoutePath("single-1", "/complete"))) {
        return jsonResponse({
          fileKey: "files.sample.date",
          fileKeyParts: ["files", "sample", "date"],
          uploaderId: null,
          filename: "sample.txt",
          sizeBytes: 3,
          contentType: "text/plain",
          checksum: null,
          visibility: "private",
          tags: null,
          metadata: null,
          status: "ready",
          storageProvider: "filesystem",
          createdAt: now,
          updatedAt: now,
          completedAt: now,
          deletedAt: null,
          errorCode: null,
          errorMessage: null,
        });
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `http://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    const file = new Blob(["hey"], { type: "text/plain" });

    const result = await helpers.createUploadAndTransfer(file, {
      provider: TEST_PROVIDER,
      fileKey: "files.sample.date",
    });

    expect(typeof result.file.createdAt).toBe("string");
    expect(result.file.createdAt).toBe(now);
    expect(result.file.completedAt).toBe(now);
    expect(result.file.deletedAt).toBeNull();
    expect(calls).toContain(`POST http://local${uploadRoutePath("single-1", "/progress")}`);
    expect(calls).toContain(`POST http://local${uploadRoutePath("single-1", "/complete")}`);
  });

  it("falls back to buffered proxy uploads when streaming fails", async () => {
    const progress: number[] = [];
    let attempts = 0;

    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/uploads")) {
        const body = JSON.parse(_init?.body as string);
        expect(body.provider).toBe(TEST_PROVIDER);
        expect(body.fileKey).toBe("files.assets.logo");
        return jsonResponse({
          uploadId: "proxy-2",
          fileKey: "files.assets.logo",
          provider: TEST_PROVIDER,
          status: "created",
          strategy: "proxy",
          expiresAt: new Date().toISOString(),
          upload: {
            mode: "single",
            transport: "proxy",
            statusEndpoint: uploadRoutePath("proxy-2"),
            progressEndpoint: uploadRoutePath("proxy-2", "/progress"),
            completeEndpoint: uploadRoutePath("proxy-2", "/complete"),
            abortEndpoint: uploadRoutePath("proxy-2", "/abort"),
            contentEndpoint: uploadRoutePath("proxy-2", "/content"),
          },
        });
      }

      if (url.endsWith(uploadRoutePath("proxy-2", "/content"))) {
        attempts += 1;
        if (attempts === 1) {
          throw new TypeError("Failed to fetch");
        }
        const init = _init as RequestInit & { duplex?: string };
        expect(init.duplex).toBeUndefined();
        expect(init.body).toBeInstanceOf(Blob);
        return jsonResponse({ fileKey: "files.assets.logo", status: "ready" });
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `http://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    const file = new Blob(["hello"], { type: "text/plain" });

    const result = await helpers.createUploadAndTransfer(file, {
      provider: TEST_PROVIDER,
      fileKey: "files.assets.logo",
      onProgress: (value) => progress.push(value.bytesUploaded),
    });

    expect(result.file.fileKey).toBe("files.assets.logo");
    expect(progress[progress.length - 1]).toBe(5);
  });

  it("throws actionable guidance when proxy transport fails for both attempts", async () => {
    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/uploads")) {
        const body = JSON.parse(_init?.body as string);
        expect(body.provider).toBe(TEST_PROVIDER);
        expect(body.fileKey).toBe("files.assets.fail");
        return jsonResponse({
          uploadId: "proxy-3",
          fileKey: "files.assets.fail",
          provider: TEST_PROVIDER,
          status: "created",
          strategy: "proxy",
          expiresAt: new Date().toISOString(),
          upload: {
            mode: "single",
            transport: "proxy",
            statusEndpoint: uploadRoutePath("proxy-3"),
            progressEndpoint: uploadRoutePath("proxy-3", "/progress"),
            completeEndpoint: uploadRoutePath("proxy-3", "/complete"),
            abortEndpoint: uploadRoutePath("proxy-3", "/abort"),
            contentEndpoint: uploadRoutePath("proxy-3", "/content"),
          },
        });
      }

      if (url.endsWith(uploadRoutePath("proxy-3", "/content"))) {
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
        provider: TEST_PROVIDER,
        fileKey: "files.assets.fail",
      }),
    ).rejects.toThrow(/Server selected proxy upload strategy/);

    await expect(
      helpers.createUploadAndTransfer(file, {
        provider: TEST_PROVIDER,
        fileKey: "files.assets.fail",
      }),
    ).rejects.toThrow(/\/uploads\/:uploadId\/content/);
  });

  it("fails fast when proxy endpoint uses an unsupported protocol", async () => {
    let contentEndpointCalled = false;

    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/uploads")) {
        const body = JSON.parse(_init?.body as string);
        expect(body.provider).toBe(TEST_PROVIDER);
        expect(body.fileKey).toBe("files.assets.protocol");
        return jsonResponse({
          uploadId: "proxy-4",
          fileKey: "files.assets.protocol",
          provider: TEST_PROVIDER,
          status: "created",
          strategy: "proxy",
          expiresAt: new Date().toISOString(),
          upload: {
            mode: "single",
            transport: "proxy",
            statusEndpoint: uploadRoutePath("proxy-4"),
            progressEndpoint: uploadRoutePath("proxy-4", "/progress"),
            completeEndpoint: uploadRoutePath("proxy-4", "/complete"),
            abortEndpoint: uploadRoutePath("proxy-4", "/abort"),
            contentEndpoint: uploadRoutePath("proxy-4", "/content"),
          },
        });
      }

      if (url.endsWith(uploadRoutePath("proxy-4", "/content"))) {
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
        provider: TEST_PROVIDER,
        fileKey: "files.assets.protocol",
      }),
    ).rejects.toThrow(/must use http:\/\/ or https:\/\//);

    expect(contentEndpointCalled).toBe(false);
  });

  it("downloads through /content when content method is selected", async () => {
    const fileKey = "files.sample.download";
    const downloadUrlPath = byKeyDownloadUrlPath(TEST_PROVIDER, fileKey);
    const contentPath = byKeyContentPath(TEST_PROVIDER, fileKey);
    const calls: string[] = [];
    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);

      if (url.endsWith(downloadUrlPath)) {
        return jsonResponse(
          { message: "Signed URLs are not supported", code: "SIGNED_URL_UNSUPPORTED" },
          { status: 400 },
        );
      }

      if (url.endsWith(contentPath)) {
        return new Response("payload", { status: 200 });
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `http://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    const response = await helpers.downloadFile(fileKey, {
      provider: TEST_PROVIDER,
      method: "content",
    });
    expect(await response.text()).toBe("payload");
    expect(calls.some((url) => url.endsWith(downloadUrlPath))).toBe(false);
  });

  it("throws programming guidance when signed-url method is unsupported", async () => {
    const fileKey = "files.sample.download-mismatch";
    const downloadUrlPath = byKeyDownloadUrlPath(TEST_PROVIDER, fileKey);
    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith(downloadUrlPath)) {
        return jsonResponse(
          { message: "Signed URLs are not supported", code: "SIGNED_URL_UNSUPPORTED" },
          { status: 400 },
        );
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `https://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    await expect(
      helpers.downloadFile(fileKey, {
        provider: TEST_PROVIDER,
        method: "signed-url",
      }),
    ).rejects.toThrow(/programming error/i);
  });

  it("throws content-specific fallback guidance when content download is unsupported", async () => {
    const fileKey = "files.sample.content-mismatch";
    const contentPath = byKeyContentPath(TEST_PROVIDER, fileKey);
    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith(contentPath)) {
        return jsonResponse(
          { message: "Download streaming unsupported", code: "SIGNED_URL_UNSUPPORTED" },
          { status: 400 },
        );
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `https://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    await expect(
      helpers.downloadFile(fileKey, {
        provider: TEST_PROVIDER,
        method: "content",
      }),
    ).rejects.toThrow(/The 'content' download endpoint is unsupported.*Use method 'signed-url'/i);
  });

  it("throws actionable context when content download request fails", async () => {
    const fileKey = "files.sample.download-fail";
    const contentPath = byKeyContentPath(TEST_PROVIDER, fileKey);
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

    await expect(
      helpers.downloadFile(fileKey, { provider: TEST_PROVIDER, method: "content" }),
    ).rejects.toThrow(/\/files\/by-key\/content/);
  });

  it("throws actionable context when signed URL download request fails", async () => {
    const fileKey = "files.sample.download-url";
    const downloadUrlPath = byKeyDownloadUrlPath(TEST_PROVIDER, fileKey);
    const signedUrl = "https://storage.example.com/object?token=secret&X-Amz-Signature=abc123";
    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith(downloadUrlPath)) {
        return jsonResponse({
          url: signedUrl,
        });
      }

      if (url === signedUrl) {
        throw new TypeError("Network dropped");
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `https://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    let thrown: Error | null = null;
    try {
      await helpers.downloadFile(fileKey, { provider: TEST_PROVIDER, method: "signed-url" });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain("https://storage.example.com/object");
    expect(thrown?.message).not.toContain("token=secret");
    expect(thrown?.message).not.toContain("X-Amz-Signature=abc123");
  });

  it("redacts signed URL query params when the download response is not ok", async () => {
    const fileKey = "files.sample.download-url-status";
    const downloadUrlPath = byKeyDownloadUrlPath(TEST_PROVIDER, fileKey);
    const signedUrl = "https://storage.example.com/object?token=secret&X-Amz-Signature=abc123";
    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith(downloadUrlPath)) {
        return jsonResponse({
          url: signedUrl,
        });
      }

      if (url === signedUrl) {
        return jsonResponse({ message: "Request expired" }, { status: 403 });
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `https://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    let thrown: Error | null = null;
    try {
      await helpers.downloadFile(fileKey, { provider: TEST_PROVIDER, method: "signed-url" });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain("https://storage.example.com/object");
    expect(thrown?.message).toContain("response status 403");
    expect(thrown?.message).toContain("message: Request expired");
    expect(thrown?.message).not.toContain("token=secret");
    expect(thrown?.message).not.toContain("X-Amz-Signature=abc123");
  });

  it("requires callers to specify an explicit download method", async () => {
    const helpers = createUploadHelpers({
      buildUrl: (path) => `https://local${path}`,
      fetcher: (async () => new Response(null, { status: 500 })) as typeof fetch,
    });

    await expect(
      helpers.downloadFile("files.sample.download-missing", { provider: TEST_PROVIDER } as never),
    ).rejects.toThrow(/Download method is required/);
  });

  it("requires callers to specify an explicit download provider", async () => {
    const helpers = createUploadHelpers({
      buildUrl: (path) => `https://local${path}`,
      fetcher: (async () => new Response(null, { status: 500 })) as typeof fetch,
    });

    await expect(
      helpers.downloadFile("files.sample.download-missing-provider", {
        method: "content",
      } as never),
    ).rejects.toThrow(/Download provider is required/);
  });

  it("requires callers to specify provider and file key when creating uploads", async () => {
    const helpers = createUploadHelpers({
      buildUrl: (path) => `https://local${path}`,
      fetcher: (async () => new Response(null, { status: 500 })) as typeof fetch,
    });

    await expect(
      helpers.createUploadAndTransfer(new Blob(["data"]), {
        fileKey: "files.sample.upload-missing-provider",
      } as never),
    ).rejects.toThrow(/Provider is required/);

    await expect(
      helpers.createUploadAndTransfer(new Blob(["data"]), {
        provider: TEST_PROVIDER,
      } as never),
    ).rejects.toThrow(/File key is required/);
  });
});
