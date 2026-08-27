import type { ActionFunctionArgs } from "react-router";

import { requireBackofficeContextScopeFromRouteParams } from "@/backoffice-runtime/scope-codec";
import { createUploadFileSystem } from "@/files/contributors/upload";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

export async function action({ request, context, params }: ActionFunctionArgs) {
  const scope = requireBackofficeContextScopeFromRouteParams(params);
  if (scope.kind === "system") {
    throw new Response("System scope does not have a workspace filesystem.", { status: 400 });
  }
  const execution = await requireBackofficeContext(request, context, scope);
  const path = new URL(request.url).searchParams.get("path")?.trim() ?? "";
  if (!path.startsWith("/workspace/") || path.split("/").includes("..")) {
    throw new Response("A safe absolute /workspace file path is required.", { status: 400 });
  }
  const sizeBytes = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Response("A valid Content-Length header is required.", { status: 411 });
  }
  if (!request.body) {
    throw new Response("A file request body is required.", { status: 400 });
  }

  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const uploadObject = kernel.scoped("UPLOAD", scope, runtime.objects.upload);
  const fileSystem = createUploadFileSystem(
    {
      origin: new URL(request.url).origin,
      request,
      objects: runtime.objects,
      execution,
      kernel,
      filePrincipal: kernel.resolveFilePrincipal(execution),
      staticFileArtifacts: () => ({}),
      uploadObject,
    },
    {
      mountPoint: "/workspace",
      object: uploadObject,
      provider: UPLOAD_PROVIDER_DATABASE,
    },
  );
  const content = request.body as ReadableStream<Uint8Array>;
  await fileSystem.writeFileStream(path, content, {
    sizeBytes,
    contentType: request.headers.get("content-type") ?? "application/octet-stream",
  });

  return Response.json({ path, sizeBytes });
}
