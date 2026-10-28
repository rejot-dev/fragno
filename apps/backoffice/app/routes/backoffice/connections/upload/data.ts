import type { BackofficeOrganizationContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import type { UploadFragment } from "@/fragno/upload-server";
import { getUploadDurableObject } from "@/worker-runtime/durable-objects";

type UploadDeleteFileResult = {
  ok: boolean;
  error: string | null;
};

const createUploadRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  organization: BackofficeOrganizationContextScope,
) => {
  const uploadDo = getUploadDurableObject(context, organization);
  return createRouteCaller<UploadFragment>({
    baseUrl: request.url,
    mountRoute: "/api/upload",
    baseHeaders: request.headers,
    fetch: uploadDo.http.fetch.bind(uploadDo),
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

export async function deleteUploadFile(
  request: Request,
  context: Readonly<RouterContextProvider>,
  organization: BackofficeOrganizationContextScope,
  fileKey: string,
): Promise<UploadDeleteFileResult> {
  try {
    const callRoute = createUploadRouteCaller(request, context, organization);
    const response = await callRoute("DELETE", "/files/by-key", {
      query: { key: fileKey },
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
