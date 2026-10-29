import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { absoluteFilePathSchema } from "@fragno-private/backoffice-ui/absolute-file-path";
import type { RouterContextProvider } from "react-router";
import { z } from "zod";

import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import {
  PI_AGENT_MAX_ATTACHMENTS,
  piAgentAttachmentsKeyPrefix,
  type PiAgentAttachment,
} from "@/fragno/pi/agent/pi-agent-attachments";
import { throwOnRouteRuntimeError } from "@/fragno/runtime-tools/runtime-errors";
import { createUploadRouteCaller } from "@/fragno/upload-server";
import { openLargeFiles } from "@/routes/backoffice/files/large-files.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

const attachmentLocationsSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("workspace"), path: absoluteFilePathSchema }),
      z.strictObject({ kind: z.literal("blob"), key: z.string().min(1) }),
    ]),
  )
  .max(PI_AGENT_MAX_ATTACHMENTS);

/**
 * The files a message to `agentName` carries, from the `attachments` form field: a JSON array of
 * where the chat uploaded them, in the workspace or as blobs. Their type and size are read from
 * where they are kept, since the browser's would reach the agent unchecked.
 */
export async function readPiAgentAttachments({
  request,
  context,
  scope,
  agentName,
  field,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  scope: BackofficeContextScope;
  agentName: string;
  field: FormDataEntryValue | null;
}): Promise<{ attachments: PiAgentAttachment[] } | { error: string }> {
  if (field === null) {
    return { attachments: [] };
  }
  let locations: z.output<typeof attachmentLocationsSchema>;
  try {
    locations = attachmentLocationsSchema.parse(JSON.parse(String(field)));
  } catch {
    return {
      error: `Attach at most ${PI_AGENT_MAX_ATTACHMENTS} files by where they were uploaded.`,
    };
  }
  const prefix = piAgentAttachmentsKeyPrefix(agentName);
  if (
    locations.some((location) =>
      location.kind === "workspace"
        ? !location.path.startsWith(`/workspace/${prefix}`)
        : !location.key.startsWith(prefix),
    )
  ) {
    return { error: "Attach only files uploaded in this conversation." };
  }
  if (locations.length === 0) {
    return { attachments: [] };
  }
  if (scope.kind === "system") {
    return { error: "System scope has no workspace to attach files from." };
  }

  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const execution = await requireBackofficeContext(request, context, scope);
  const uploadObject = kernel.scoped("UPLOAD", execution.scope, runtime.objects.upload);
  const routes = createUploadRouteCaller(uploadObject.http, request);
  const largeFiles = openLargeFiles(context, execution);
  const attachments: PiAgentAttachment[] = [];
  for (const location of locations) {
    if (location.kind === "workspace") {
      const file = await routes("GET", "/files/by-key", {
        query: { key: location.path.slice("/workspace/".length) },
      });
      if (
        (file.type === "error" && file.error.code === "FILE_NOT_FOUND") ||
        (file.type === "json" && file.data.status === "deleted")
      ) {
        return { error: `${location.path.split("/").at(-1)} is no longer in the workspace.` };
      }
      if (file.type !== "json") {
        return throwOnRouteRuntimeError(file, {
          runtimeLabel: "Upload",
          label: "attachment lookup",
        });
      }
      attachments.push({
        ...location,
        contentType: file.data.contentType,
        sizeBytes: file.data.sizeBytes,
      });
      continue;
    }
    if (largeFiles.status !== "available") {
      return { error: "This scope keeps no large files." };
    }
    const blob = await largeFiles.files.read(
      async (blobs) => await blobs("GET", "/blobs/by-key", { query: { key: location.key } }),
    );
    if (blob.type === "error" && blob.error.code === "BLOB_NOT_FOUND") {
      return { error: `${location.key.split("/").at(-1)} is no longer among the large files.` };
    }
    if (blob.type !== "json") {
      return throwOnRouteRuntimeError(blob, { runtimeLabel: "Blobs", label: "attachment lookup" });
    }
    attachments.push({
      ...location,
      contentType: blob.data.contentType,
      sizeBytes: blob.data.sizeBytes,
    });
  }
  return { attachments };
}
