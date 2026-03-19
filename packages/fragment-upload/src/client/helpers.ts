import type { UploadChecksum } from "../storage/types";
import type { FileMetadata, FileVisibility, UploadStrategy } from "../types";

export type UploadProgress = {
  bytesUploaded: number;
  totalBytes: number;
  partsUploaded: number;
  totalParts?: number;
};

export type CreateUploadAndTransferOptions = {
  provider: string;
  fileKey: string;
  filename?: string;
  contentType?: string;
  checksum?: UploadChecksum | null;
  tags?: string[];
  visibility?: FileVisibility;
  uploaderId?: string;
  metadata?: Record<string, unknown>;
  onProgress?: (progress: UploadProgress) => void;
};

export type DownloadMethod = "signed-url" | "content";

export type DownloadFileOptions = {
  provider: string;
  method: DownloadMethod;
};

export type UploadCreateResponse = {
  uploadId: string;
  fileKey: string;
  provider: string;
  status: "created" | "in_progress";
  strategy: UploadStrategy;
  expiresAt: string;
  upload: {
    mode: "single" | "multipart";
    transport: "direct" | "proxy";
    uploadUrl?: string;
    uploadHeaders?: Record<string, string>;
    partSizeBytes?: number;
    maxParts?: number;
    statusEndpoint: string;
    progressEndpoint: string;
    partsEndpoint?: string;
    partsCompleteEndpoint?: string;
    completeEndpoint: string;
    abortEndpoint: string;
    contentEndpoint?: string;
  };
};

export type UploadHelpers = {
  createUploadAndTransfer: (
    file: Blob,
    options: CreateUploadAndTransferOptions,
  ) => Promise<{ upload: UploadCreateResponse; file: FileMetadata }>;
  downloadFile: (fileKey: string, options: DownloadFileOptions) => Promise<Response>;
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const PROXY_UPLOAD_STRATEGY_HINT =
  "Server selected proxy upload strategy for this file (no direct upload URL was returned). If you expected direct-to-storage upload, your active provider/config does not support direct upload for this request.";
const PROXY_UPLOAD_RECOVERY_HINT =
  "Verify the /uploads/:uploadId/content endpoint is reachable from the client, or switch provider/config so /uploads returns a direct strategy.";
const DOWNLOAD_METHOD_HINT =
  "Pick the download method explicitly: use 'signed-url' for GET /files/by-key/download-url, otherwise use 'content' for GET /files/by-key/content.";

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

const toErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return "Unknown network error";
};

const readMessageFromPayload = (payload: unknown): string | null => {
  if (
    payload &&
    typeof payload === "object" &&
    "message" in payload &&
    typeof payload.message === "string" &&
    payload.message.length > 0
  ) {
    return payload.message;
  }

  return null;
};

const toAbsoluteUrl = (url: string): URL | null => {
  try {
    if (typeof window !== "undefined" && window.location?.origin) {
      return new URL(url, window.location.origin);
    }

    return new URL(url, "http://fragno.local");
  } catch {
    return null;
  }
};

const validateProxyContentUrl = (url: string): string | null => {
  const parsed = toAbsoluteUrl(url);
  if (!parsed) {
    return `Proxy upload endpoint '${url}' is not a valid URL.`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Proxy upload endpoint '${url}' must use http:// or https://.`;
  }

  if (
    typeof window !== "undefined" &&
    window.location?.protocol === "https:" &&
    parsed.protocol === "http:"
  ) {
    return `Proxy upload endpoint '${url}' uses http:// on a https:// page.`;
  }

  return null;
};

const buildProxyUploadErrorMessage = (input: {
  endpointUrl: string;
  status?: number;
  streamError?: unknown;
  fallbackError?: unknown;
}) => {
  const detailLines: string[] = [];
  if (typeof input.status === "number") {
    detailLines.push(`response status ${input.status}`);
  }
  if (input.streamError !== undefined) {
    detailLines.push(`streamed upload error: ${toErrorMessage(input.streamError)}`);
  }
  if (input.fallbackError !== undefined) {
    detailLines.push(`buffered upload error: ${toErrorMessage(input.fallbackError)}`);
  }

  const details = detailLines.length > 0 ? ` Details: ${detailLines.join(" | ")}.` : "";
  return `${PROXY_UPLOAD_STRATEGY_HINT} Proxy upload to '${input.endpointUrl}' failed.${details} ${PROXY_UPLOAD_RECOVERY_HINT}`;
};

const buildDownloadRequestErrorMessage = (input: {
  endpointUrl: string;
  status?: number;
  payload?: unknown;
  requestError?: unknown;
  hint?: string;
}) => {
  const detailLines: string[] = [];
  if (typeof input.status === "number") {
    detailLines.push(`response status ${input.status}`);
  }

  const payloadMessage = readMessageFromPayload(input.payload);
  if (payloadMessage) {
    detailLines.push(`message: ${payloadMessage}`);
  }

  if (input.requestError !== undefined) {
    detailLines.push(`request error: ${toErrorMessage(input.requestError)}`);
  }

  const details = detailLines.length > 0 ? ` Details: ${detailLines.join(" | ")}.` : "";
  const hint = input.hint ? ` ${input.hint}` : "";
  return `Download request to '${input.endpointUrl}' failed.${details}${hint}`;
};

const sanitizeSignedDownloadUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "<redacted-signed-url>";
  }
};

const readErrorCodeFromPayload = (payload: unknown): string | null => {
  if (payload && typeof payload === "object" && "code" in payload) {
    const code = (payload as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }

  return null;
};

const hasText = (value: string | undefined | null): value is string =>
  typeof value === "string" && value.trim().length > 0;

const requireUploadEndpoint = (endpoint: string | undefined, label: string) => {
  if (!hasText(endpoint)) {
    throw new Error(`Missing ${label} endpoint for upload`);
  }

  return endpoint;
};

const buildByKeyQuery = (provider: string, fileKey: string) =>
  new URLSearchParams({ provider, key: fileKey }).toString();

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
    progressEndpoint: string,
    progress: UploadProgress,
    onProgress?: (progress: UploadProgress) => void,
  ) => {
    onProgress?.(progress);
    await fetchJson<{ bytesUploaded: number; partsUploaded: number }>(progressEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bytesUploaded: progress.bytesUploaded,
        partsUploaded: progress.partsUploaded,
      }),
    });
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

    if (!hasText(options.provider)) {
      throw new Error("Provider is required");
    }

    if (!hasText(options.fileKey)) {
      throw new Error("File key is required");
    }

    const upload = await fetchJson<UploadCreateResponse>("/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: options.provider,
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
    const progressEndpoint = requireUploadEndpoint(upload.upload.progressEndpoint, "progress");

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
        progressEndpoint,
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
      const partsCompleteEndpoint = requireUploadEndpoint(
        upload.upload.partsCompleteEndpoint,
        "multipart completion",
      );

      const totalParts = Math.ceil(totalBytes / partSizeBytes);
      if (upload.upload.maxParts && totalParts > upload.upload.maxParts) {
        throw new Error("Multipart upload exceeds maximum parts");
      }

      const partNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);
      const partUrls = await fetchJson<{
        parts: {
          partNumber: number;
          url: string;
          headers?: Record<string, string>;
        }[];
      }>(upload.upload.partsEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partNumbers }),
      });

      const parts = partUrls.parts.sort((a, b) => a.partNumber - b.partNumber);
      const completedParts: {
        partNumber: number;
        etag: string;
        sizeBytes: number;
      }[] = [];
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
        completedParts.push({
          partNumber: part.partNumber,
          etag,
          sizeBytes: partSize,
        });
        completionParts.push({ partNumber: part.partNumber, etag });

        bytesUploaded += partSize;
        partsUploaded += 1;
        await reportProgress(
          progressEndpoint,
          {
            bytesUploaded,
            totalBytes,
            partsUploaded,
            totalParts,
          },
          options.onProgress,
        );
      }

      await fetchJson<{ bytesUploaded: number; partsUploaded: number }>(partsCompleteEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: completedParts }),
      });

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

    const proxyContentUrl = buildUrl(upload.upload.contentEndpoint);
    const proxyUrlValidationError = validateProxyContentUrl(proxyContentUrl);
    if (proxyUrlValidationError) {
      throw new Error(`${proxyUrlValidationError} ${PROXY_UPLOAD_RECOVERY_HINT}`);
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
      proxyResponse = await fetcher(proxyContentUrl, requestInit);
    } catch (streamError) {
      let fallbackResponse: Response;
      try {
        fallbackResponse = await fetcher(
          proxyContentUrl,
          buildRequestInit(defaultOptions, {
            method: "PUT",
            headers: { "Content-Type": DEFAULT_CONTENT_TYPE },
            body: file,
          }),
        );
      } catch (fallbackError) {
        throw new Error(
          buildProxyUploadErrorMessage({
            endpointUrl: proxyContentUrl,
            streamError,
            fallbackError,
          }),
        );
      }

      if (!fallbackResponse.ok) {
        throw new Error(
          buildProxyUploadErrorMessage({
            endpointUrl: proxyContentUrl,
            status: fallbackResponse.status,
            streamError,
          }),
        );
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
      throw new Error(
        buildProxyUploadErrorMessage({
          endpointUrl: proxyContentUrl,
          status: proxyResponse.status,
        }),
      );
    }

    const proxyMetadata = (await proxyResponse.json()) as FileMetadata;

    return { upload, file: proxyMetadata };
  };

  const downloadFile: UploadHelpers["downloadFile"] = async (fileKey, options) => {
    if (!hasText(fileKey)) {
      throw new Error("File key is required");
    }

    if (!options || !hasText(options.provider)) {
      throw new Error("Download provider is required");
    }

    if (!options || (options.method !== "signed-url" && options.method !== "content")) {
      throw new Error(`Download method is required. ${DOWNLOAD_METHOD_HINT}`);
    }

    const byKeyQuery = buildByKeyQuery(options.provider, fileKey);

    if (options.method === "signed-url") {
      const downloadUrlEndpoint = buildUrl(`/files/by-key/download-url?${byKeyQuery}`);

      let downloadUrlResponse: Response;
      try {
        downloadUrlResponse = await fetcher(
          downloadUrlEndpoint,
          buildRequestInit(defaultOptions, { method: "GET" }),
        );
      } catch (error) {
        throw new Error(
          buildDownloadRequestErrorMessage({
            endpointUrl: downloadUrlEndpoint,
            requestError: error,
          }),
        );
      }

      if (!downloadUrlResponse.ok) {
        const errorPayload = await readJsonSafely(downloadUrlResponse);
        const errorCode = readErrorCodeFromPayload(errorPayload);
        const hint =
          errorCode === "SIGNED_URL_UNSUPPORTED"
            ? "Requested method 'signed-url' is unsupported by this storage adapter. This is a programming error. Use method 'content' when streaming downloads are available."
            : undefined;
        throw new Error(
          buildDownloadRequestErrorMessage({
            endpointUrl: downloadUrlEndpoint,
            status: downloadUrlResponse.status,
            payload: errorPayload,
            hint,
          }),
        );
      }

      const payload = (await downloadUrlResponse.json()) as {
        url: string;
        headers?: Record<string, string>;
      };
      const sanitizedUrl = sanitizeSignedDownloadUrl(payload.url);

      let response: Response;
      try {
        response = await fetcher(payload.url, {
          method: "GET",
          headers: payload.headers,
        });
      } catch (error) {
        throw new Error(
          buildDownloadRequestErrorMessage({
            endpointUrl: sanitizedUrl,
            requestError: error,
          }),
        );
      }

      if (!response.ok) {
        const payloadError = await readJsonSafely(response);
        throw new Error(
          buildDownloadRequestErrorMessage({
            endpointUrl: sanitizedUrl,
            status: response.status,
            payload: payloadError,
          }),
        );
      }

      return response;
    }

    const contentEndpoint = buildUrl(`/files/by-key/content?${byKeyQuery}`);
    let contentResponse: Response;
    try {
      contentResponse = await fetcher(
        contentEndpoint,
        buildRequestInit(defaultOptions, { method: "GET" }),
      );
    } catch (error) {
      throw new Error(
        buildDownloadRequestErrorMessage({
          endpointUrl: contentEndpoint,
          requestError: error,
        }),
      );
    }

    if (!contentResponse.ok) {
      const contentError = await readJsonSafely(contentResponse);
      const errorCode = readErrorCodeFromPayload(contentError);
      const hint =
        errorCode === "SIGNED_URL_UNSUPPORTED"
          ? "The 'content' download endpoint is unsupported by this storage adapter. This request used method 'content'. Use method 'signed-url' when signed downloads are available."
          : undefined;
      throw new Error(
        buildDownloadRequestErrorMessage({
          endpointUrl: contentEndpoint,
          status: contentResponse.status,
          payload: contentError,
          hint,
        }),
      );
    }

    return contentResponse;
  };

  return {
    createUploadAndTransfer,
    downloadFile,
  };
};
