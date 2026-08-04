import { assert, describe, expect, test, vi } from "vitest";

import type { UploadObject } from "@/backoffice-runtime/object-registry";
import type { PreparedUploadedFileReference } from "@/fragno/prepared-upload";

import { createUploadRuntime } from "./upload-runtime";

const file: PreparedUploadedFileReference = {
  kind: "prepared-upload",
  scope: { kind: "org", orgId: "org-1" },
  uploadId: "upload-1",
  provider: "database",
  fileKey: "generated-ui/file.txt",
  filename: "file.txt",
  sizeBytes: 5,
  contentType: "text/plain",
  expiresAt: "2027-01-01T00:00:00.000Z",
};

const createObject = (fetch: (request: Request) => Promise<Response>) =>
  ({ fetch }) as UploadObject;

describe("Upload runtime", () => {
  test("reads prepared UTF-8 content", async () => {
    const fetch = vi.fn<(request: Request) => Promise<Response>>(
      async () => new Response("hello", { headers: { "Content-Length": "5" } }),
    );
    const runtime = createUploadRuntime(createObject(fetch));

    await expect(runtime.readPrepared({ file })).resolves.toEqual({
      file,
      encoding: "utf8",
      text: "hello",
      byteLength: 5,
    });
    const request = fetch.mock.calls[0]?.[0];
    assert(request);
    assert(new URL(request.url).pathname === "/api/upload/uploads/upload-1/content");
  });

  test("reads binary content as base64", async () => {
    const runtime = createUploadRuntime(
      createObject(async () => new Response(new Uint8Array([0, 1, 2, 255]))),
    );

    await expect(
      runtime.readPrepared({ file: { ...file, sizeBytes: 4 }, encoding: "base64" }),
    ).resolves.toMatchObject({
      encoding: "base64",
      base64: "AAEC/w==",
      byteLength: 4,
    });
  });

  test("reads chunked binary content as bytes without a text round trip", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 1]));
        controller.enqueue(new Uint8Array([2, 255]));
        controller.close();
      },
    });
    const runtime = createUploadRuntime(createObject(async () => new Response(stream)));

    await expect(
      runtime.readPrepared({ file: { ...file, sizeBytes: 4 }, encoding: "bytes" }),
    ).resolves.toEqual({
      file: { ...file, sizeBytes: 4 },
      encoding: "bytes",
      bytes: new Uint8Array([0, 1, 2, 255]),
      byteLength: 4,
    });
  });

  test("rejects content above the declared read limit before fetching", async () => {
    const fetch = vi.fn<(request: Request) => Promise<Response>>(async () => new Response("hello"));
    const runtime = createUploadRuntime(createObject(fetch));

    await expect(runtime.readPrepared({ file, maxBytes: 4 })).rejects.toThrow(
      "exceeding the 4 byte read limit",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test("cancels chunked content as soon as it exceeds the read limit", async () => {
    let cancelReason: unknown;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const runtime = createUploadRuntime(createObject(async () => new Response(stream)));

    await expect(
      runtime.readPrepared({ file: { ...file, sizeBytes: 4 }, maxBytes: 4 }),
    ).rejects.toThrow("exceeding the 4 byte read limit");
    expect(cancelReason).toBeInstanceOf(Error);
  });

  test("commits and discards the same prepared reference", async () => {
    const fetch = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json({ files: [{ provider: file.provider, fileKey: file.fileKey }] }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const runtime = createUploadRuntime(createObject(fetch));

    await expect(runtime.commitPrepared({ file })).resolves.toMatchObject({
      kind: "uploaded-file",
      uploadId: file.uploadId,
      fileKey: file.fileKey,
    });
    await expect(runtime.discardPrepared({ file })).resolves.toEqual({
      discarded: true,
      uploadId: file.uploadId,
    });

    const commitRequest = fetch.mock.calls[0]?.[0];
    assert(commitRequest);
    assert(commitRequest.method === "POST");
    assert(new URL(commitRequest.url).pathname === "/api/upload/files/commit-prepared");
    expect(await commitRequest.json()).toEqual({
      entries: [
        {
          kind: "write",
          uploadId: file.uploadId,
          precondition: { kind: "absent" },
        },
      ],
    });

    const discardRequest = fetch.mock.calls[1]?.[0];
    assert(discardRequest);
    assert(discardRequest.method === "POST");
    assert(
      new URL(discardRequest.url).pathname ===
        `/api/upload/uploads/${encodeURIComponent(file.uploadId)}/abort`,
    );
  });
});
