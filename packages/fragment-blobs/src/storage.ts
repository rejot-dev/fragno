/**
 * Object storage that hands out presigned URLs, so blob bytes travel between callers and storage
 * without passing through the server.
 */
export interface BlobStorage {
  /** A URL that accepts one PUT of the object's bytes, sent with `headers` unchanged. */
  createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; headers: Record<string, string> }>;
  /** A URL whose GET returns the object's bytes. */
  createDownloadUrl(input: { objectKey: string; expiresInSeconds: number }): Promise<string>;
  /**
   * `length` bytes of the object from byte `offset`, which must lie within it, provided the object
   * still carries `etag`.
   */
  readObjectRange(input: {
    objectKey: string;
    etag: string;
    offset: number;
    length: number;
  }): Promise<ObjectRange>;
  /** What storage holds at the key, or null when it holds no object there. */
  describeObject(objectKey: string): Promise<StoredObject | null>;
  /** Deletes the object; deleting a missing object succeeds. */
  deleteObject(objectKey: string): Promise<void>;
}

export type StoredObject = {
  sizeBytes: bigint;
  /** Storage's tag for the object's bytes, without quotes; it changes whenever the bytes do. */
  etag: string;
};

export type ObjectRange =
  | { status: "read"; bytes: Uint8Array<ArrayBuffer> }
  | { status: "missing" }
  // Storage holds other bytes than those tagged `etag`.
  | { status: "changed" };

/** Signs S3 API requests with AWS Signature Version 4. */
export type S3Signer = {
  /** Signs a request the server sends itself, with the signature in its headers. */
  sign(request: {
    method: "GET" | "HEAD" | "DELETE";
    url: string;
    headers: Record<string, string>;
  }): Promise<{ url: string; headers: Record<string, string> }>;
  /** Signs a request someone else sends, with the signature in the URL. */
  presign(request: {
    method: "GET" | "PUT";
    url: string;
    headers: Record<string, string>;
    expiresInSeconds: number;
  }): Promise<{ url: string; headers: Record<string, string> }>;
};

export type S3BlobStorageOptions = {
  /** The S3 API endpoint, e.g. `https://<account>.r2.cloudflarestorage.com` for R2. */
  endpoint: string;
  bucket: string;
  /** Addresses the bucket in the URL's path instead of its hostname, as R2 and MinIO need. */
  pathStyle: boolean;
  signer: S3Signer;
  /** Sends the signed storage requests. */
  fetch: typeof fetch;
};

/** Blob storage in an S3-compatible bucket, such as R2. */
export function createS3BlobStorage(options: S3BlobStorageOptions): BlobStorage {
  const objectUrl = (objectKey: string) => {
    const url = new URL(options.endpoint);
    const basePath = url.pathname.replace(/^\/+|\/+$/g, "");
    const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
    if (options.pathStyle) {
      url.pathname = `/${[basePath, options.bucket, encodedKey].filter(Boolean).join("/")}`;
    } else {
      url.hostname = `${options.bucket}.${url.hostname}`;
      url.pathname = `/${[basePath, encodedKey].filter(Boolean).join("/")}`;
    }
    return url.toString();
  };

  const send = async (
    method: "GET" | "HEAD" | "DELETE",
    objectKey: string,
    headers: Record<string, string>,
  ) => {
    const signed = await options.signer.sign({ method, url: objectUrl(objectKey), headers });
    // Called unbound: Workers' global `fetch` throws when called as a method of another object.
    const sendRequest = options.fetch;
    return await sendRequest(signed.url, { method, headers: signed.headers });
  };

  return {
    async createUploadUrl({ objectKey, contentType, expiresInSeconds }) {
      return await options.signer.presign({
        method: "PUT",
        url: objectUrl(objectKey),
        headers: { "Content-Type": contentType },
        expiresInSeconds,
      });
    },
    async createDownloadUrl({ objectKey, expiresInSeconds }) {
      const signed = await options.signer.presign({
        method: "GET",
        url: objectUrl(objectKey),
        headers: {},
        expiresInSeconds,
      });
      return signed.url;
    },
    async readObjectRange({ objectKey, etag, offset, length }) {
      const response = await send("GET", objectKey, {
        "If-Match": `"${etag}"`,
        Range: `bytes=${offset}-${offset + length - 1}`,
      });
      if (response.status === 404) {
        return { status: "missing" };
      }
      if (response.status === 412) {
        return { status: "changed" };
      }
      if (response.status !== 206) {
        throw new Error(`Storage could not read object ${objectKey} (${response.status}).`);
      }
      return { status: "read", bytes: new Uint8Array(await response.arrayBuffer()) };
    },
    async describeObject(objectKey) {
      const response = await send("HEAD", objectKey, {});
      if (response.status === 404) {
        return null;
      }
      const contentLength = response.headers.get("content-length");
      const etag = response.headers.get("etag")?.replace(/^"|"$/g, "");
      if (!response.ok || contentLength === null || !/^\d+$/.test(contentLength) || !etag) {
        throw new Error(`Storage could not describe object ${objectKey} (${response.status}).`);
      }
      return { sizeBytes: BigInt(contentLength), etag };
    },
    async deleteObject(objectKey) {
      const response = await send("DELETE", objectKey, {});
      if (!response.ok && response.status !== 404) {
        throw new Error(`Storage could not delete object ${objectKey} (${response.status}).`);
      }
    },
  };
}
