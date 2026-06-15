import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import { isUploadDirectoryMarker } from "@/files/contributors/upload-markers";
import type { UploadFragment } from "@/fragno/upload-server";
import { getUploadDurableObject } from "@/worker-runtime/durable-objects";

import type { UploadConfigState } from "./shared";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

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
    provider?: string;
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
    if (options.provider) {
      query.provider = options.provider;
    }
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
        files: ((response.data.files ?? []) as UploadFileRecord[]).filter(
          (file) => !isUploadDirectoryMarker(file),
        ),
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
      const file = response.data as UploadFileRecord;
      return isUploadDirectoryMarker(file)
        ? { file: null, error: "File not found." }
        : { file, error: null };
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

    return {
      result: null,
      error: `Failed to get download URL (${response.status}).`,
    };
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
