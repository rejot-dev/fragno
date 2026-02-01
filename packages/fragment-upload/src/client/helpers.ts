import { encodeFileKey, type FileKeyEncoded, type FileKeyParts } from "../keys";
import type { UploadChecksum } from "../storage/types";
import type { FileMetadata, FileVisibility, UploadStrategy } from "../types";

export type UploadProgress = {
  bytesUploaded: number;
  totalBytes: number;
  partsUploaded: number;
  totalParts?: number;
};

export type CreateUploadAndTransferOptions = {
  keyParts?: FileKeyParts;
  fileKey?: FileKeyEncoded;
  filename?: string;
  contentType?: string;
  checksum?: UploadChecksum | null;
  tags?: string[];
  visibility?: FileVisibility;
  uploaderId?: string;
  metadata?: Record<string, unknown>;
  onProgress?: (progress: UploadProgress) => void;
};

export type UploadCreateResponse = {
  uploadId: string;
  fileKey: string;
  status: "created";
  strategy: UploadStrategy;
  expiresAt: string;
  upload: {
    mode: "single" | "multipart";
    transport: "direct" | "proxy";
    uploadUrl?: string;
    uploadHeaders?: Record<string, string>;
    partSizeBytes?: number;
    maxParts?: number;
    partsEndpoint?: string;
    completeEndpoint: string;
    contentEndpoint?: string;
  };
};

export type UploadHelpers = {
  createUploadAndTransfer: (
    file: Blob,
    options: CreateUploadAndTransferOptions,
  ) => Promise<{ upload: UploadCreateResponse; file: FileMetadata }>;
  downloadFile: (fileKeyOrParts: FileKeyEncoded | FileKeyParts) => Promise<Response>;
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

const mergeHeaders = (base?: HeadersInit, next?: HeadersInit) => {
  const merged = new Headers(base ?? undefined);

  if (!next) {
    return merged;
  }

  if (next instanceof Headers) {
    for (const [key, value] of next.entries()) {
      merged.set(key, value);
    }
  } else if (Array.isArray(next)) {
    for (const [key, value] of next) {
      merged.set(key, value);
    }
  } else {
    for (const [key, value] of Object.entries(next)) {
      merged.set(key, value);
    }
  }

  return merged;
};

const buildRequestInit = (defaults: RequestInit | undefined, init: RequestInit): RequestInit => {
  if (!defaults) {
    return init;
  }

  return {
    ...defaults,
    ...init,
    headers: mergeHeaders(defaults.headers, init.headers),
  };
};

const readJsonSafely = async (response: Response) => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
};

export const createUploadHelpers = (input: {
  buildUrl: (path: string) => string;
  fetcher: typeof fetch;
  defaultOptions?: RequestInit;
}): UploadHelpers => {
  const { buildUrl, fetcher, defaultOptions } = input;

  const fetchJson = async <T>(
    path: string,
    init: RequestInit,
    expectedErrorCode?: string,
  ): Promise<T> => {
    const response = await fetcher(buildUrl(path), buildRequestInit(defaultOptions, init));

    if (!response.ok) {
      const payload = await readJsonSafely(response);
      const code =
        typeof payload === "object" && payload ? (payload as { code?: string }).code : undefined;
      if (expectedErrorCode && code === expectedErrorCode) {
        throw new Error(expectedErrorCode);
      }
      const message =
        typeof payload === "object" && payload && "message" in payload
          ? String((payload as { message?: string }).message)
          : `Request failed (${response.status})`;
      throw new Error(message);
    }

    return (await response.json()) as T;
  };

  const reportProgress = async (
    uploadId: string,
    progress: UploadProgress,
    onProgress?: (progress: UploadProgress) => void,
  ) => {
    onProgress?.(progress);
    await fetchJson<{ bytesUploaded: number; partsUploaded: number }>(
      `/uploads/${uploadId}/progress`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bytesUploaded: progress.bytesUploaded,
          partsUploaded: progress.partsUploaded,
        }),
      },
    );
  };

  const createUploadAndTransfer: UploadHelpers["createUploadAndTransfer"] = async (
    file,
    options,
  ) => {
    const filename =
      options.filename ??
      (typeof File !== "undefined" && file instanceof File && file.name ? file.name : "upload");
    const contentType =
      options.contentType ??
      (file.type && file.type.length > 0 ? file.type : undefined) ??
      DEFAULT_CONTENT_TYPE;
    const sizeBytes = file.size;

    if (!options.keyParts && !options.fileKey) {
      throw new Error("File key parts or file key is required");
    }

    const upload = await fetchJson<UploadCreateResponse>("/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyParts: options.keyParts,
        fileKey: options.fileKey,
        filename,
        sizeBytes,
        contentType,
        checksum: options.checksum ?? null,
        tags: options.tags,
        visibility: options.visibility,
        uploaderId: options.uploaderId,
        metadata: options.metadata,
      }),
    });

    const totalBytes = sizeBytes;
    let bytesUploaded = 0;
    let partsUploaded = 0;

    if (upload.strategy === "direct-single") {
      if (!upload.upload.uploadUrl) {
        throw new Error("Missing upload URL for direct upload");
      }

      const uploadResponse = await fetcher(upload.upload.uploadUrl, {
        method: "PUT",
        headers: upload.upload.uploadHeaders,
        body: file,
      });

      if (!uploadResponse.ok) {
        throw new Error(`Direct upload failed (${uploadResponse.status})`);
      }

      bytesUploaded = totalBytes;
      partsUploaded = 1;
      await reportProgress(
        upload.uploadId,
        {
          bytesUploaded,
          totalBytes,
          partsUploaded,
          totalParts: 1,
        },
        options.onProgress,
      );

      const fileMetadata = await fetchJson<FileMetadata>(upload.upload.completeEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      return { upload, file: fileMetadata };
    }

    if (upload.strategy === "direct-multipart") {
      const partSizeBytes = upload.upload.partSizeBytes;
      if (!partSizeBytes || !upload.upload.partsEndpoint) {
        throw new Error("Missing multipart configuration for upload");
      }

      const totalParts = Math.ceil(totalBytes / partSizeBytes);
      if (upload.upload.maxParts && totalParts > upload.upload.maxParts) {
        throw new Error("Multipart upload exceeds maximum parts");
      }

      const partNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);
      const partUrls = await fetchJson<{
        parts: { partNumber: number; url: string; headers?: Record<string, string> }[];
      }>(upload.upload.partsEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partNumbers }),
      });

      const parts = partUrls.parts.sort((a, b) => a.partNumber - b.partNumber);
      const completedParts: { partNumber: number; etag: string; sizeBytes: number }[] = [];
      const completionParts: { partNumber: number; etag: string }[] = [];

      for (const part of parts) {
        const start = (part.partNumber - 1) * partSizeBytes;
        const end = Math.min(start + partSizeBytes, totalBytes);
        const partBlob = file.slice(start, end);

        const response = await fetcher(part.url, {
          method: "PUT",
          headers: part.headers,
          body: partBlob,
        });

        if (!response.ok) {
          throw new Error(`Multipart upload failed (${response.status})`);
        }

        const etag = response.headers.get("ETag") ?? response.headers.get("etag");
        if (!etag) {
          throw new Error("Missing ETag for uploaded part");
        }

        const partSize = partBlob.size;
        completedParts.push({ partNumber: part.partNumber, etag, sizeBytes: partSize });
        completionParts.push({ partNumber: part.partNumber, etag });

        bytesUploaded += partSize;
        partsUploaded += 1;
        await reportProgress(
          upload.uploadId,
          {
            bytesUploaded,
            totalBytes,
            partsUploaded,
            totalParts,
          },
          options.onProgress,
        );
      }

      await fetchJson<{ bytesUploaded: number; partsUploaded: number }>(
        `/uploads/${upload.uploadId}/parts/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parts: completedParts }),
        },
      );

      const fileMetadata = await fetchJson<FileMetadata>(upload.upload.completeEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: completionParts }),
      });

      return { upload, file: fileMetadata };
    }

    if (!upload.upload.contentEndpoint) {
      throw new Error("Missing proxy content endpoint for upload");
    }

    const source = file.stream();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const reader = source.getReader();

        const pump = (): void => {
          reader.read().then(
            ({ done, value }) => {
              if (done) {
                controller.close();
                return;
              }

              if (value) {
                bytesUploaded += value.byteLength;
                options.onProgress?.({
                  bytesUploaded,
                  totalBytes,
                  partsUploaded: 0,
                });
                controller.enqueue(value);
              }

              pump();
            },
            (error) => {
              controller.error(error);
            },
          );
        };

        pump();
      },
    });

    const requestInit = buildRequestInit(defaultOptions, {
      method: "PUT",
      headers: { "Content-Type": DEFAULT_CONTENT_TYPE },
      body: stream,
    }) as RequestInit & { duplex?: "half" };
    requestInit.duplex = "half";

    let proxyResponse: Response;
    try {
      proxyResponse = await fetcher(buildUrl(upload.upload.contentEndpoint), requestInit);
    } catch (_error) {
      const fallbackResponse = await fetcher(
        buildUrl(upload.upload.contentEndpoint),
        buildRequestInit(defaultOptions, {
          method: "PUT",
          headers: { "Content-Type": DEFAULT_CONTENT_TYPE },
          body: file,
        }),
      );

      if (!fallbackResponse.ok) {
        throw new Error(`Proxy upload failed (${fallbackResponse.status})`);
      }

      options.onProgress?.({
        bytesUploaded: totalBytes,
        totalBytes,
        partsUploaded: 0,
      });

      const fallbackMetadata = (await fallbackResponse.json()) as FileMetadata;
      return { upload, file: fallbackMetadata };
    }

    if (!proxyResponse.ok) {
      throw new Error(`Proxy upload failed (${proxyResponse.status})`);
    }

    const proxyMetadata = (await proxyResponse.json()) as FileMetadata;

    return { upload, file: proxyMetadata };
  };

  const downloadFile: UploadHelpers["downloadFile"] = async (fileKeyOrParts) => {
    const fileKey = Array.isArray(fileKeyOrParts) ? encodeFileKey(fileKeyOrParts) : fileKeyOrParts;

    const downloadUrlResponse = await fetcher(
      buildUrl(`/files/${fileKey}/download-url`),
      buildRequestInit(defaultOptions, { method: "GET" }),
    );

    if (downloadUrlResponse.ok) {
      const payload = (await downloadUrlResponse.json()) as {
        url: string;
        headers?: Record<string, string>;
      };

      return fetcher(payload.url, {
        method: "GET",
        headers: payload.headers,
      });
    }

    const errorPayload = await readJsonSafely(downloadUrlResponse);
    const errorCode =
      typeof errorPayload === "object" && errorPayload
        ? (errorPayload as { code?: string }).code
        : undefined;

    if (errorCode !== "SIGNED_URL_UNSUPPORTED") {
      const message =
        typeof errorPayload === "object" && errorPayload && "message" in errorPayload
          ? String((errorPayload as { message?: string }).message)
          : `Download failed (${downloadUrlResponse.status})`;
      throw new Error(message);
    }

    return fetcher(
      buildUrl(`/files/${fileKey}/content`),
      buildRequestInit(defaultOptions, { method: "GET" }),
    );
  };

  return {
    createUploadAndTransfer,
    downloadFile,
  };
};
