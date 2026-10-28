import { assert } from "vitest";

import type { BlobsR2Bucket, BlobsR2Buckets } from "@/fragno/blobs-server";

export function bucketUrl(bucket: BlobsR2Bucket) {
  return `${bucket.endpoint.replace(/\/$/, "")}/${bucket.bucket}/`;
}

/** The tag the fake R2 gives these bytes, as Blobs reports it. */
export async function etagOf(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Buffer.from(digest).toString("hex").slice(0, 32);
}

export type FakeR2 = ReturnType<typeof createFakeR2>;

/**
 * R2's S3 API for the given buckets. Backoffice reaches it with signed requests; callers holding a
 * presigned URL reach it with the signature in the query, and no credentials of their own.
 */
export function createFakeR2(buckets: BlobsR2Buckets) {
  // Keyed by the object's URL, which names its bucket.
  const objects = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; contentType: string; etag: string }
  >();
  // Flipped to simulate an outage: every request fails, as R2 does when it cannot serve.
  const availability = { reachable: true };

  // Like Workers' global `fetch`, it refuses to be called as a method of another object.
  const fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    if (!availability.reachable) {
      return new Response("InternalError", { status: 500 });
    }
    const request = new Request(input, init);
    const url = new URL(request.url);
    const objectUrl = `${url.origin}${url.pathname}`;
    const bucket = Object.values(buckets).find((candidate) =>
      objectUrl.startsWith(bucketUrl(candidate)),
    );
    assert(bucket, `Unexpected storage URL ${objectUrl}`);
    const presigned = url.searchParams.get("X-Amz-Credential")?.startsWith(bucket.accessKeyId);
    const signed = request.headers
      .get("authorization")
      ?.startsWith(`AWS4-HMAC-SHA256 Credential=${bucket.accessKeyId}/`);
    if (!presigned && !signed) {
      return new Response("AccessDenied", { status: 403 });
    }
    const object = objects.get(objectUrl);

    switch (request.method) {
      case "PUT": {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const etag = `"${await etagOf(bytes)}"`;
        objects.set(objectUrl, {
          bytes,
          contentType: request.headers.get("content-type") ?? "application/octet-stream",
          etag,
        });
        return new Response(null, { status: 200, headers: { etag } });
      }
      case "HEAD":
      case "GET":
        if (!object) {
          return new Response(null, { status: 404 });
        }
        return new Response(request.method === "GET" ? object.bytes : null, {
          headers: {
            "content-length": String(object.bytes.byteLength),
            "content-type": object.contentType,
            etag: object.etag,
          },
        });
      case "DELETE":
        objects.delete(objectUrl);
        return new Response(null, { status: 204 });
      default:
        return new Response(null, { status: 405 });
    }
  };

  return {
    objects,
    fetch,
    setReachable: (reachable: boolean) => {
      availability.reachable = reachable;
    },
  };
}

/** A request from outside Backoffice, such as a sandbox or browser following a presigned URL. */
export async function requestFromOutside(r2: FakeR2, url: string, init?: RequestInit) {
  const { fetch } = r2;
  return await fetch(url, init);
}
