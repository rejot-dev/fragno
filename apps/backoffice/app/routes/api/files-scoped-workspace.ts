import type { ActionFunctionArgs } from "react-router";

import { requireBackofficeContextScopeFromRouteParams } from "@/backoffice-runtime/scope-codec";
import { inferFileContentType } from "@/file-collection/file-content-type";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";
import { createUploadRouteCaller } from "@/fragno/upload-server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

export async function action({ request, context, params }: ActionFunctionArgs) {
  const scope = requireBackofficeContextScopeFromRouteParams(params);
  if (scope.kind === "system") {
    throw new Response("System scope does not have a workspace filesystem.", { status: 400 });
  }
  await requireBackofficeContext(request, context, scope);
  const path = new URL(request.url).searchParams.get("path")?.trim() ?? "";
  if (!path.startsWith("/workspace/") || path.split("/").includes("..")) {
    throw new Response("A safe absolute /workspace file path is required.", { status: 400 });
  }
  const contentLength = request.headers.get("content-length");
  const sizeBytes = Number(contentLength);
  if (!contentLength?.trim() || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Response("A valid Content-Length header is required.", { status: 411 });
  }
  if (!request.body) {
    throw new Response("A file request body is required.", { status: 400 });
  }

  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const uploadObject = kernel.scoped("UPLOAD", scope, runtime.objects.upload);
  const routes = createUploadRouteCaller(uploadObject.http);
  const fileKey = path.slice("/workspace/".length);
  let contentType =
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ||
    "application/octet-stream";
  if (isGenericBinaryContentType(contentType)) {
    const existing = await routes("GET", "/files/by-key", {
      query: { provider: UPLOAD_PROVIDER_DATABASE, key: fileKey },
    });
    if (existing.type === "error" && existing.status !== 404) {
      return Response.json(existing.error, { status: existing.status });
    }
    if (existing.type !== "json" && existing.type !== "error") {
      throw new Error("Workspace upload could not inspect existing file metadata.");
    }
    const existingContentType =
      existing.type === "json" && existing.data.status !== "deleted"
        ? existing.data.contentType
        : null;
    contentType =
      existingContentType && !isGenericBinaryContentType(existingContentType)
        ? existingContentType
        : inferFileContentType(fileKey);
  }
  const created = await routes("POST", "/uploads", {
    body: {
      provider: UPLOAD_PROVIDER_DATABASE,
      fileKey,
      filename: path.split("/").at(-1)!,
      sizeBytes,
      contentType,
    },
  });
  if (created.type === "error") {
    return Response.json(created.error, { status: created.status });
  }
  if (created.type !== "json" || created.data.strategy !== "proxy") {
    throw new Error("Workspace upload requires a proxy upload session.");
  }
  const written = await routes("PUT", "/uploads/:uploadId/content", {
    pathParams: { uploadId: created.data.uploadId },
    headers: { "content-type": "application/octet-stream" },
    body: request.body,
  });
  if (written.type === "error") {
    return Response.json(written.error, { status: written.status });
  }
  if (written.type !== "json" || written.data.kind !== "published") {
    throw new Error("Workspace upload did not publish its file.");
  }

  return Response.json({ path, sizeBytes });
}

function isGenericBinaryContentType(contentType: string): boolean {
  const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mimeType === "application/octet-stream" || mimeType === "binary/octet-stream";
}
