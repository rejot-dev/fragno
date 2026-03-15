import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import { getUploadDurableObject } from "@/cloudflare/cloudflare-utils";
import type { UploadProvider } from "@/fragno/upload";
import type { UploadFragment } from "@/fragno/upload-server";

import type { UploadConfigState } from "./shared";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export type UploadSessionStatus = {
  uploadId: string;
  fileKey: string;
  provider: string;
  status: string;
  strategy: string;
  expectedSizeBytes: number;
  bytesUploaded: number;
  partsUploaded: number;
  partSizeBytes?: number;
  expiresAt?: string | Date;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  completedAt?: string | Date | null;
  errorCode?: string | null;
  errorMessage?: string | null;
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

export type UploadCreateResponse = {
  uploadId: string;
  fileKey: string;
  provider: string;
  status: "created" | "in_progress";
  strategy: string;
  expiresAt?: string | Date;
  upload: UploadSessionStatus["upload"];
};

export type UploadFileRecord = {
  provider: string;
  fileKey: string;
  status: string;
  uploaderId?: string | null;
  uploadId?: string | null;
  sizeBytes: number;
  filename: string;
  contentType: string;
  checksumAlgo?: string | null;
  checksumValue?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
  visibility?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  deletedAt?: string | Date | null;
};

export type UploadFilesResult = {
  files: UploadFileRecord[];
  cursor?: string;
  hasNextPage: boolean;
  filesError: string | null;
};

export type UploadConfigResult = {
  configState: UploadConfigState | null;
  configError: string | null;
};

export type UploadSessionResult = {
  session: UploadSessionStatus | null;
  error: string | null;
};

export type UploadCreateSessionResult = {
  session: UploadCreateResponse | null;
  error: string | null;
};

export type UploadFileResult = {
  file: UploadFileRecord | null;
  error: string | null;
};

export type UploadDownloadUrlResult = {
  result: {
    url: string;
    headers?: Record<string, string>;
    expiresAt: string | Date;
  } | null;
  error: string | null;
};

export type UploadDeleteFileResult = {
  ok: boolean;
  error: string | null;
};

export type UploadMutationResult = {
  ok: boolean;
  error: string | null;
};

const createUploadRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const uploadDo = getUploadDurableObject(context, orgId);
  return createRouteCaller<UploadFragment>({
    baseUrl: request.url,
    mountRoute: "/api/upload",
    baseHeaders: request.headers,
    fetch: uploadDo.fetch.bind(uploadDo),
  });
};

const isSuccessStatus = (status: number) => status >= 200 && status < 300;

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

const toByKeyQuery = (provider: string, fileKey: string) => ({
  provider,
  key: fileKey,
});

export async function fetchUploadConfig(
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<UploadConfigResult> {
  try {
    const uploadDo = getUploadDurableObject(context, orgId);
    const configState = await uploadDo.getAdminConfig();
    return { configState, configError: null };
  } catch (error) {
    return {
      configState: null,
      configError: error instanceof Error ? error.message : "Failed to load configuration.",
    };
  }
}

export async function createUploadSession(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  payload: {
    provider: UploadProvider;
    fileKey: string;
    filename: string;
    sizeBytes: number;
    contentType: string;
    uploaderId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<UploadCreateSessionResult> {
  try {
    const callRoute = createUploadRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/uploads", { body: payload });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return { session: response.data as UploadCreateResponse, error: null };
    }

    if (response.type === "error") {
      return { session: null, error: response.error.message };
    }

    if (response.type === "json" && !isSuccessStatus(response.status)) {
      return {
        session: null,
        error:
          readMessageFromPayload(response.data) ?? `Failed to create upload (${response.status}).`,
      };
    }

    return { session: null, error: `Failed to create upload (${response.status}).` };
  } catch (error) {
    return {
      session: null,
      error: error instanceof Error ? error.message : "Failed to create upload.",
    };
  }
}

export async function fetchUploadSessionStatus(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  uploadId: string,
): Promise<UploadSessionResult> {
  try {
    const callRoute = createUploadRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/uploads/:uploadId", {
      pathParams: { uploadId },
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return { session: response.data as UploadSessionStatus, error: null };
    }

    if (response.type === "error") {
      return { session: null, error: response.error.message };
    }

    if (response.type === "json" && !isSuccessStatus(response.status)) {
      return {
        session: null,
        error:
          readMessageFromPayload(response.data) ?? `Failed to fetch upload (${response.status}).`,
      };
    }

    return { session: null, error: `Failed to fetch upload (${response.status}).` };
  } catch (error) {
    return {
      session: null,
      error: error instanceof Error ? error.message : "Failed to load upload.",
    };
  }
}

export async function abortUploadSession(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  uploadId: string,
): Promise<UploadMutationResult> {
  try {
    const callRoute = createUploadRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/uploads/:uploadId/abort", {
      pathParams: { uploadId },
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return { ok: true, error: null };
    }

    if (response.type === "error") {
      return { ok: false, error: response.error.message };
    }

    if (response.type === "json" && !isSuccessStatus(response.status)) {
      return {
        ok: false,
        error:
          readMessageFromPayload(response.data) ?? `Failed to abort upload (${response.status}).`,
      };
    }

    return { ok: false, error: `Failed to abort upload (${response.status}).` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to abort upload.",
    };
  }
}

export async function completeUploadSession(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  uploadId: string,
  payload?: {
    sizeBytes?: number;
    parts?: { partNumber: number; etag: string }[];
  },
): Promise<UploadFileResult> {
  try {
    const callRoute = createUploadRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/uploads/:uploadId/complete", {
      pathParams: { uploadId },
      body: payload ?? {},
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return { file: response.data as UploadFileRecord, error: null };
    }

    if (response.type === "error") {
      return { file: null, error: response.error.message };
    }

    if (response.type === "json" && !isSuccessStatus(response.status)) {
      return {
        file: null,
        error:
          readMessageFromPayload(response.data) ??
          `Failed to complete upload (${response.status}).`,
      };
    }

    return { file: null, error: `Failed to complete upload (${response.status}).` };
  } catch (error) {
    return {
      file: null,
      error: error instanceof Error ? error.message : "Failed to complete upload.",
    };
  }
}

export async function fetchUploadFiles(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  options: {
    prefix?: string;
    pageSize?: number;
    cursor?: string;
    status?: string;
    uploaderId?: string;
  } = {},
): Promise<UploadFilesResult> {
  try {
    const callRoute = createUploadRouteCaller(request, context, orgId);
    const requestedPageSize =
      typeof options.pageSize === "number" && Number.isFinite(options.pageSize)
        ? options.pageSize
        : DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedPageSize));

    const query: Record<string, string> = {
      pageSize: String(pageSize),
    };
    if (options.prefix) {
      query.prefix = options.prefix;
    }
    if (options.cursor) {
      query.cursor = options.cursor;
    }
    if (options.status) {
      query.status = options.status;
    }
    if (options.uploaderId) {
      query.uploaderId = options.uploaderId;
    }

    const response = await callRoute("GET", "/files", { query });
    if (response.type === "json" && isSuccessStatus(response.status)) {
      return {
        files: (response.data.files ?? []) as UploadFileRecord[],
        cursor: response.data.cursor,
        hasNextPage: response.data.hasNextPage ?? false,
        filesError: null,
      };
    }

    if (response.type === "error") {
      return {
        files: [],
        cursor: undefined,
        hasNextPage: false,
        filesError: response.error.message,
      };
    }

    if (response.type === "json" && !isSuccessStatus(response.status)) {
      return {
        files: [],
        cursor: undefined,
        hasNextPage: false,
        filesError:
          readMessageFromPayload(response.data) ?? `Failed to list files (${response.status}).`,
      };
    }

    return {
      files: [],
      cursor: undefined,
      hasNextPage: false,
      filesError: `Failed to list files (${response.status}).`,
    };
  } catch (error) {
    return {
      files: [],
      cursor: undefined,
      hasNextPage: false,
      filesError: error instanceof Error ? error.message : "Failed to load files.",
    };
  }
}

export async function fetchUploadFile(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  provider: string,
  fileKey: string,
): Promise<UploadFileResult> {
  try {
    const callRoute = createUploadRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/files/by-key", {
      query: toByKeyQuery(provider, fileKey),
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return { file: response.data as UploadFileRecord, error: null };
    }

    if (response.type === "error") {
      return { file: null, error: response.error.message };
    }

    if (response.type === "json" && !isSuccessStatus(response.status)) {
      return {
        file: null,
        error:
          readMessageFromPayload(response.data) ?? `Failed to fetch file (${response.status}).`,
      };
    }

    return { file: null, error: `Failed to fetch file (${response.status}).` };
  } catch (error) {
    return {
      file: null,
      error: error instanceof Error ? error.message : "Failed to load file.",
    };
  }
}

export async function fetchUploadDownloadUrl(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  provider: string,
  fileKey: string,
): Promise<UploadDownloadUrlResult> {
  try {
    const callRoute = createUploadRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/files/by-key/download-url", {
      query: toByKeyQuery(provider, fileKey),
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return {
        result: response.data as UploadDownloadUrlResult["result"],
        error: null,
      };
    }

    if (response.type === "error") {
      return { result: null, error: response.error.message };
    }

    if (response.type === "json" && !isSuccessStatus(response.status)) {
      return {
        result: null,
        error:
          readMessageFromPayload(response.data) ??
          `Failed to get download URL (${response.status}).`,
      };
    }

    return { result: null, error: `Failed to get download URL (${response.status}).` };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : "Failed to get download URL.",
    };
  }
}

export async function deleteUploadFile(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  provider: string,
  fileKey: string,
): Promise<UploadDeleteFileResult> {
  try {
    const callRoute = createUploadRouteCaller(request, context, orgId);
    const response = await callRoute("DELETE", "/files/by-key", {
      query: toByKeyQuery(provider, fileKey),
    });

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return { ok: true, error: null };
    }

    if (response.type === "error") {
      return { ok: false, error: response.error.message };
    }

    if (response.type === "json" && !isSuccessStatus(response.status)) {
      return {
        ok: false,
        error:
          readMessageFromPayload(response.data) ?? `Failed to delete file (${response.status}).`,
      };
    }

    return { ok: false, error: `Failed to delete file (${response.status}).` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to delete file.",
    };
  }
}
