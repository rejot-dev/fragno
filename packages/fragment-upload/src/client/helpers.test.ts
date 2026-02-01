import { describe, expect, it } from "vitest";
import { createUploadHelpers } from "./helpers";
import { encodeFileKey } from "../keys";

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

describe("upload client helpers", () => {
  it("splits multipart uploads, tracks progress, and completes", async () => {
    const progress: number[] = [];
    const calls: string[] = [];

    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(`${_init?.method ?? "GET"} ${url}`);

      if (url.endsWith("/uploads")) {
        return jsonResponse({
          uploadId: "123",
          fileKey: "files.users.1.avatar",
          status: "created",
          strategy: "direct-multipart",
          expiresAt: new Date().toISOString(),
          upload: {
            mode: "multipart",
            transport: "direct",
            partSizeBytes: 4,
            maxParts: 10,
            partsEndpoint: "/uploads/123/parts",
            completeEndpoint: "/uploads/123/complete",
          },
        });
      }

      if (url.endsWith("/uploads/123/parts")) {
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

      if (url.includes("/uploads/123/progress")) {
        return jsonResponse({ bytesUploaded: 0, partsUploaded: 0 });
      }

      if (url.endsWith("/uploads/123/parts/complete")) {
        const body = JSON.parse(_init?.body as string);
        expect(body.parts).toEqual([
          { partNumber: 1, etag: "etag-1", sizeBytes: 4 },
          { partNumber: 2, etag: "etag-2", sizeBytes: 4 },
          { partNumber: 3, etag: "etag-3", sizeBytes: 2 },
        ]);
        return jsonResponse({ bytesUploaded: 10, partsUploaded: 3 });
      }

      if (url.endsWith("/uploads/123/complete")) {
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
      keyParts: ["files", "users", 1, "avatar"],
      onProgress: (value) => progress.push(value.bytesUploaded),
    });

    expect(result.file.fileKey).toBe("files.users.1.avatar");
    expect(progress).toEqual([4, 8, 10]);
    expect(calls).toContain("POST http://local/uploads/123/parts/complete");
    expect(calls).toContain("POST http://local/uploads/123/complete");
  });

  it("streams proxy uploads and reports progress", async () => {
    const progress: number[] = [];

    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/uploads")) {
        const body = JSON.parse(_init?.body as string);
        expect(body.contentType).toBe("text/plain");
        return jsonResponse({
          uploadId: "proxy-1",
          fileKey: "files.assets.banner",
          status: "created",
          strategy: "proxy",
          expiresAt: new Date().toISOString(),
          upload: {
            mode: "single",
            transport: "proxy",
            contentEndpoint: "/uploads/proxy-1/content",
            completeEndpoint: "/uploads/proxy-1/complete",
          },
        });
      }

      if (url.endsWith("/uploads/proxy-1/content")) {
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
      keyParts: ["files", "assets", "banner"],
      onProgress: (value) => progress.push(value.bytesUploaded),
    });

    expect(result.file.fileKey).toBe("files.assets.banner");
    expect(progress[progress.length - 1]).toBe(5);
  });

  it("returns file metadata date fields as strings", async () => {
    const now = new Date("2024-01-01T12:00:00.000Z").toISOString();

    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/uploads")) {
        return jsonResponse({
          uploadId: "single-1",
          fileKey: "files.sample.date",
          status: "created",
          strategy: "direct-single",
          expiresAt: new Date().toISOString(),
          upload: {
            mode: "single",
            transport: "direct",
            uploadUrl: "https://storage.local/upload",
            completeEndpoint: "/uploads/single-1/complete",
          },
        });
      }

      if (url === "https://storage.local/upload") {
        return new Response(null, { status: 200 });
      }

      if (url.includes("/uploads/single-1/progress")) {
        return jsonResponse({ bytesUploaded: 0, partsUploaded: 0 });
      }

      if (url.endsWith("/uploads/single-1/complete")) {
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
      keyParts: ["files", "sample", "date"],
    });

    expect(typeof result.file.createdAt).toBe("string");
    expect(result.file.createdAt).toBe(now);
    expect(result.file.completedAt).toBe(now);
    expect(result.file.deletedAt).toBeNull();
  });

  it("falls back to buffered proxy uploads when streaming fails", async () => {
    const progress: number[] = [];
    let attempts = 0;

    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/uploads")) {
        return jsonResponse({
          uploadId: "proxy-2",
          fileKey: "files.assets.logo",
          status: "created",
          strategy: "proxy",
          expiresAt: new Date().toISOString(),
          upload: {
            mode: "single",
            transport: "proxy",
            contentEndpoint: "/uploads/proxy-2/content",
            completeEndpoint: "/uploads/proxy-2/complete",
          },
        });
      }

      if (url.endsWith("/uploads/proxy-2/content")) {
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
      keyParts: ["files", "assets", "logo"],
      onProgress: (value) => progress.push(value.bytesUploaded),
    });

    expect(result.file.fileKey).toBe("files.assets.logo");
    expect(progress[progress.length - 1]).toBe(5);
  });

  it("falls back to streaming when signed download urls are unsupported", async () => {
    const fileKey = encodeFileKey(["files", "sample", "download"]);
    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith(`/files/${fileKey}/download-url`)) {
        return jsonResponse(
          { message: "Signed URLs are not supported", code: "SIGNED_URL_UNSUPPORTED" },
          { status: 400 },
        );
      }

      if (url.endsWith(`/files/${fileKey}/content`)) {
        return new Response("payload", { status: 200 });
      }

      return new Response(null, { status: 404 });
    };

    const helpers = createUploadHelpers({
      buildUrl: (path) => `http://local${path}`,
      fetcher: fetcher as typeof fetch,
    });

    const response = await helpers.downloadFile(["files", "sample", "download"]);
    expect(await response.text()).toBe("payload");
  });
});
