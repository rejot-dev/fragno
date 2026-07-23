import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import type { UploadAdminConfigResponse } from "@/fragno/upload";
import type { UploadFragment } from "@/fragno/upload-server";
import { getUploadDurableObject } from "@/worker-runtime/durable-objects";

type UploadConfigResult = {
  configState: UploadAdminConfigResponse | null;
  configError: string | null;
};

type UploadDownloadUrlResult = {
  result: {
    url: string;
    headers?: Record<string, string>;
    expiresAt: string | Date;
  } | null;
  error: string | null;
};

type UploadDeleteFileResult = {
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
