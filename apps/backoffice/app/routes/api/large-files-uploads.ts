import { z } from "zod";

import { requireBackofficeContextScopeFromRouteParams } from "@/backoffice-runtime/scope-codec";
import { authorizeBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import {
  blobsFailure,
  openLargeFiles,
  refusalFailure,
  type LargeFilesFailure,
} from "@/routes/backoffice/files/large-files.server";

import type { Route } from "./+types/large-files-uploads";

const uploadStepSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("start"), key: z.string(), contentType: z.string() }),
  z.object({ intent: z.literal("complete"), uploadId: z.string() }),
  z.object({ intent: z.literal("discard"), key: z.string() }),
]);

/** What the Large files page reads back from each step of an upload. */
export type LargeFileUploadResult =
  | {
      ok: true;
      step: "start";
      upload: { uploadId: string; url: string; headers: Record<string, string> };
    }
  | { ok: true; step: "complete" }
  | { ok: true; step: "discard" }
  | { ok: false; error: string };

/**
 * Starts an upload, handing the browser a presigned URL to PUT the file's bytes to, and completes
 * it once they are stored; discarding deletes a blob its uploader no longer wants. An API route rather than a page action: an expired credential is a 401
 * the page refreshes and retries, where page middleware would redirect the submission away.
 */
export async function action({ request, context, params }: Route.ActionArgs) {
  const scope = requireBackofficeContextScopeFromRouteParams(params);
  const authorization = await authorizeBackofficeContext(request, context, scope);
  if (!authorization.ok) {
    return authorization.response;
  }
  const respond = (result: LargeFileUploadResult, status = 200) =>
    Response.json(result, { status, headers: authorization.headers });
  const fail = ({ status, message }: LargeFilesFailure) =>
    respond({ ok: false, error: message }, status);

  const step = uploadStepSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!step.success) {
    return fail({ status: 400, message: "Malformed large file upload request." });
  }
  const largeFiles = openLargeFiles(context, authorization.execution);
  if (largeFiles.status !== "available") {
    return fail({ status: 404, message: "This scope has no large files." });
  }

  const upload = step.data;
  try {
    switch (upload.intent) {
      case "start":
        return await largeFiles.files.modify(async (blobs) => {
          const response = await blobs("POST", "/uploads", {
            body: { key: upload.key, contentType: upload.contentType },
          });
          if (response.type !== "json") {
            return fail(blobsFailure(response));
          }
          const { uploadId, url, headers } = response.data;
          return respond({ ok: true, step: "start", upload: { uploadId, url, headers } });
        });
      case "complete":
        return await largeFiles.files.modify(async (blobs) => {
          const response = await blobs("POST", "/uploads/:uploadId/complete", {
            pathParams: { uploadId: upload.uploadId },
          });
          return response.type === "json"
            ? respond({ ok: true, step: "complete" })
            : fail(blobsFailure(response));
        });
      case "discard":
        return await largeFiles.files.modify(async (blobs) => {
          const response = await blobs("DELETE", "/blobs/by-key", { query: { key: upload.key } });
          return response.type === "json"
            ? respond({ ok: true, step: "discard" })
            : fail(blobsFailure(response));
        });
      default:
        throw new Error("Unknown large file upload step.", { cause: upload satisfies never });
    }
  } catch (error) {
    return fail(refusalFailure(error));
  }
}
