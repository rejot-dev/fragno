import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { absoluteFilePathSchema } from "@fragno-private/backoffice-ui/absolute-file-path";
import type { RouterContextProvider } from "react-router";
import { z } from "zod";

import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import {
  PI_AGENT_MAX_ATTACHMENTS,
  piAgentAttachmentsFolder,
  type PiAgentAttachment,
} from "@/fragno/pi/agent/pi-agent-attachments";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";
import { createUploadRouteCaller } from "@/fragno/upload-server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

/**
 * The files a message to `agentName` carries, from the `attachments` form field: a JSON array of
 * the paths the chat uploaded them to. Their type and size are read from the workspace, since the
 * browser's would reach the agent unchecked.
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
  let paths: string[];
  try {
    paths = z
      .array(absoluteFilePathSchema)
      .max(PI_AGENT_MAX_ATTACHMENTS)
      .parse(JSON.parse(String(field)));
  } catch {
    return { error: `Attach at most ${PI_AGENT_MAX_ATTACHMENTS} files by their workspace paths.` };
  }
  const folder = piAgentAttachmentsFolder(agentName);
  if (paths.some((path) => !path.startsWith(folder))) {
    return { error: "Attach only files uploaded in this conversation." };
  }
  if (paths.length === 0) {
    return { attachments: [] };
  }
  if (scope.kind === "system") {
    return { error: "System scope has no workspace to attach files from." };
  }

  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const execution = await requireBackofficeContext(request, context, scope);
  const uploadObject = kernel.scoped("UPLOAD", execution.scope, runtime.objects.upload);
  const routes = createUploadRouteCaller(uploadObject.http, request);
  const attachments: PiAgentAttachment[] = [];
  for (const path of paths) {
    const file = await routes("GET", "/files/by-key", {
      query: { provider: UPLOAD_PROVIDER_DATABASE, key: path.slice("/workspace/".length) },
    });
    if (file.type !== "json" || file.data.status === "deleted") {
      return { error: `${path.split("/").at(-1)} is no longer in the workspace.` };
    }
    attachments.push({ path, contentType: file.data.contentType, sizeBytes: file.data.sizeBytes });
  }
  return { attachments };
}
