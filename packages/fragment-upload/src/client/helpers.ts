import type { ApplyFileEditsInput, ApplyFileEditsResult } from "../file-edits";
import type { StateSearchOptions, StateTextMatch } from "../text-index";
import type {
  FileVisibility,
  UploadChecksum,
  UploadCompletionResult,
  UploadPublicationMode,
} from "../types";

export type {
  ApplyFileEditsInput,
  ApplyFileEditsResult,
  AppliedFileEdit,
  FileEditOperation,
  FileEditSearchOptions,
} from "../file-edits";

export type UploadProgress = {
  bytesUploaded: number;
  totalBytes: number;
};

export type CreateUploadAndTransferOptions = {
  fileKey: string;
  filename?: string;
  contentType?: string;
  checksum?: UploadChecksum | null;
  tags?: string[];
  visibility?: FileVisibility;
  uploaderId?: string;
  metadata?: Record<string, unknown>;
  publicationMode?: UploadPublicationMode;
  onProgress?: (progress: UploadProgress) => void;
};

/** Candidates come from one index pass per keyword; `indexCursor` resumes within `pass`. */
export type SearchCandidateCursor = {
  pass: number;
  indexCursor?: string;
};

export type SearchFileCandidatesOptions = {
  maxCandidateFiles?: number;
  cursor?: SearchCandidateCursor;
};

export type HydrateSearchMatchesOptions = StateSearchOptions & {
  /** The candidate page's `excludedTerms`, so files from earlier passes are not matched twice. */
  excludedTerms: readonly string[];
  searchOffset?: number;
  maxBytes: number;
};

export type SearchFileCandidate = {
  key: string;
  positions: number[];
  count: number;
  /** The indexed content's size, so callers can hydrate as many candidates as their budget scans. */
  byteLength: number;
};

export type SearchFileCandidatesResult = {
  candidates: SearchFileCandidate[];
  candidateFiles: number;
  excludedTerms: string[];
  cursor?: SearchCandidateCursor;
  hasMoreCandidates: boolean;
};

export type SearchTruncationReason = "max_matches" | "max_bytes";

export type HydrateSearchMatchesResult = {
  matches: StateTextMatch[];
  scannedFiles: number;
  scannedBytes: number;
  consumedCandidates: number;
  skippedCandidates: Array<{
    key: string;
    reason: "not_found" | "too_large";
  }>;
  nextSearchOffset?: number;
  truncated: false | { reason: SearchTruncationReason };
};

export type UploadCreateResponse = {
  uploadId: string;
  fileKey: string;
  status: "created" | "in_progress";
  publicationMode: UploadPublicationMode;
  expiresAt: string;
};

export type UploadTransferResult = {
  upload: UploadCreateResponse;
} & UploadCompletionResult;

export type UploadHelpers = {
  createUploadAndTransfer: (
    file: Blob,
    options: CreateUploadAndTransferOptions,
  ) => Promise<UploadTransferResult>;
  applyEdits: (input: ApplyFileEditsInput) => Promise<ApplyFileEditsResult>;
  downloadFile: (fileKey: string) => Promise<Response>;
  /** Deletes the file at `fileKey` and its content. */
  deleteFile: (fileKey: string) => Promise<void>;
  /** Lists files that may contain any of `keywords`, one index pass per keyword. */
  searchFileCandidates: (
    glob: string,
    keywords: readonly string[],
    options: SearchFileCandidatesOptions,
  ) => Promise<SearchFileCandidatesResult>;
  /**
   * Matches the keywords in the candidates' content. Hydration reads every candidate's content, so
   * send only as many as `maxBytes` scans, by their `byteLength`.
   */
  hydrateSearchMatches: (
    candidateKeys: readonly string[],
    keywords: readonly string[],
    options: HydrateSearchMatchesOptions,
  ) => Promise<HydrateSearchMatchesResult>;
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const UPLOAD_CONTENT_RECOVERY_HINT =
  "Verify the /uploads/:uploadId/content endpoint is reachable from the client.";

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

const validateContentUrl = (url: string): string | null => {
  const parsed = toAbsoluteUrl(url);
  if (!parsed) {
    return `Upload content endpoint '${url}' is not a valid URL.`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Upload content endpoint '${url}' must use http:// or https://.`;
  }

  if (
    typeof window !== "undefined" &&
    window.location?.protocol === "https:" &&
    parsed.protocol === "http:"
  ) {
    return `Upload content endpoint '${url}' uses http:// on a https:// page.`;
  }

  return null;
};

const buildContentUploadErrorMessage = (input: {
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
  return `Upload to '${input.endpointUrl}' failed.${details} ${UPLOAD_CONTENT_RECOVERY_HINT}`;
};

const buildDownloadRequestErrorMessage = (input: {
  endpointUrl: string;
  status?: number;
  payload?: unknown;
  requestError?: unknown;
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
  return `Download request to '${input.endpointUrl}' failed.${details}`;
};

const hasText = (value: string | undefined | null): value is string =>
  typeof value === "string" && value.trim().length > 0;

const buildByKeyQuery = (fileKey: string) => new URLSearchParams({ key: fileKey }).toString();

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

    if (!hasText(options.fileKey)) {
      throw new Error("File key is required");
    }

    const upload = await fetchJson<UploadCreateResponse>("/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileKey: options.fileKey,
        filename,
        sizeBytes,
        contentType,
        checksum: options.checksum ?? null,
        tags: options.tags,
        visibility: options.visibility,
        uploaderId: options.uploaderId,
        metadata: options.metadata,
        publicationMode: options.publicationMode,
      }),
    });

    const totalBytes = sizeBytes;
    let bytesUploaded = 0;

    const contentUrl = buildUrl(`/uploads/${encodeURIComponent(upload.uploadId)}/content`);
    const contentUrlValidationError = validateContentUrl(contentUrl);
    if (contentUrlValidationError) {
      throw new Error(`${contentUrlValidationError} ${UPLOAD_CONTENT_RECOVERY_HINT}`);
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
                options.onProgress?.({ bytesUploaded, totalBytes });
                controller.enqueue(value);
              }

              pump();
            },
            (error: unknown) => {
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

    let contentResponse: Response;
    try {
      contentResponse = await fetcher(contentUrl, requestInit);
    } catch (streamError) {
      let fallbackResponse: Response;
      try {
        fallbackResponse = await fetcher(
          contentUrl,
          buildRequestInit(defaultOptions, {
            method: "PUT",
            headers: { "Content-Type": DEFAULT_CONTENT_TYPE },
            body: file,
          }),
        );
      } catch (fallbackError) {
        throw new Error(
          buildContentUploadErrorMessage({
            endpointUrl: contentUrl,
            streamError,
            fallbackError,
          }),
        );
      }

      if (!fallbackResponse.ok) {
        throw new Error(
          buildContentUploadErrorMessage({
            endpointUrl: contentUrl,
            status: fallbackResponse.status,
            streamError,
          }),
        );
      }

      options.onProgress?.({ bytesUploaded: totalBytes, totalBytes });

      const completion = (await fallbackResponse.json()) as UploadCompletionResult;
      return { upload, ...completion };
    }

    if (!contentResponse.ok) {
      throw new Error(
        buildContentUploadErrorMessage({
          endpointUrl: contentUrl,
          status: contentResponse.status,
        }),
      );
    }

    const completion = (await contentResponse.json()) as UploadCompletionResult;

    return { upload, ...completion };
  };

  const searchFileCandidates: UploadHelpers["searchFileCandidates"] = async (
    glob,
    keywords,
    options,
  ) => {
    if (!hasText(glob)) {
      throw new Error("Glob is required");
    }
    if (keywords.length === 0 || !keywords.every(hasText)) {
      throw new Error("Search keywords are required");
    }

    return await fetchJson<SearchFileCandidatesResult>("/files/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        glob,
        keywords,
        maxCandidateFiles: options.maxCandidateFiles,
        cursor: options.cursor,
      }),
    });
  };

  const hydrateSearchMatches: UploadHelpers["hydrateSearchMatches"] = async (
    candidateKeys,
    keywords,
    options,
  ) => {
    if (candidateKeys.length === 0) {
      throw new Error("At least one search candidate is required");
    }
    if (keywords.length === 0 || !keywords.every(hasText)) {
      throw new Error("Search keywords are required");
    }
    if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0) {
      throw new Error("Search byte budget must be a positive number");
    }

    const { excludedTerms, searchOffset, maxBytes, ...searchOptions } = options;
    return await fetchJson<HydrateSearchMatchesResult>("/files/search/hydrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidateKeys,
        keywords,
        excludedTerms,
        options: searchOptions,
        searchOffset,
        maxBytes,
      }),
    });
  };

  const deleteFile: UploadHelpers["deleteFile"] = async (fileKey) => {
    await fetchJson<{ ok: true }>(`/files/by-key?${buildByKeyQuery(fileKey)}`, {
      method: "DELETE",
    });
  };

  const downloadFile: UploadHelpers["downloadFile"] = async (fileKey) => {
    if (!hasText(fileKey)) {
      throw new Error("File key is required");
    }

    const byKeyQuery = buildByKeyQuery(fileKey);
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
      throw new Error(
        buildDownloadRequestErrorMessage({
          endpointUrl: contentEndpoint,
          status: contentResponse.status,
          payload: await readJsonSafely(contentResponse),
        }),
      );
    }

    return contentResponse;
  };

  const applyEdits: UploadHelpers["applyEdits"] = async (input) =>
    fetchJson<ApplyFileEditsResult>("/files/apply-edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

  return {
    applyEdits,
    createUploadAndTransfer,
    deleteFile,
    downloadFile,
    hydrateSearchMatches,
    searchFileCandidates,
  };
};
