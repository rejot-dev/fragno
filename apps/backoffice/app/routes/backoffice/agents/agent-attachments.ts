import { BLOB_MAX_SIZE_BYTES } from "@fragno-dev/backoffice-api/v0/blobs";
import { piAgentPermissionGrantRequirements } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { STATE_FILE_MAX_BYTES } from "@fragno-dev/backoffice-api/v0/state";
import type {
  ChatComposerAttachmentItem,
  ChatMessageAttachmentItem,
} from "@fragno-private/design-system/chat-attachment";
import { formatBytes } from "@fragno-private/design-system/units";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import {
  PI_AGENT_MAX_ATTACHMENTS,
  piAgentAttachmentsKeyPrefix,
  type PiAgentAttachment,
  type PiAgentAttachmentLocation,
} from "@/fragno/pi/agent/pi-agent-attachments";
import { createScopedUploadHelpers } from "@/fragno/upload-client";
import { workspaceFileName } from "@/lib/workspace-file-name";
import { discardLargeFile, uploadLargeFile } from "@/routes/backoffice/files/large-file-upload";
import {
  filesExplorerPathFromScopePath,
  filesPreviewPath,
  filesScopeBasePath,
  largeFileDownloadPath,
  largeFileUploadsPath,
} from "@/routes/backoffice/files/scope";

/** Whether an agent with these permission grants can read the files a message carries. */
function piAgentReadsUploads(permissions: readonly string[]) {
  return permissions.some((grant) =>
    piAgentPermissionGrantRequirements(grant).some(
      ({ namespace, permission }) => namespace === "upload" && permission === "read",
    ),
  );
}

type Upload =
  | { kind: "uploading"; fraction: number | null }
  | { kind: "uploaded"; location: PiAgentAttachmentLocation }
  | { kind: "failed"; message: string };

type Attachment = { id: string; file: File; previewUrl: string | null; upload: Upload };

/** Where an agent's composer uploads the files its messages carry. */
export type AgentAttachmentTarget = { scope: BackofficeRoutableScope; agentName: string };

/** The files waiting in a composer, which upload as soon as they are added. */
export type AgentAttachments = {
  items: ChatComposerAttachmentItem[];
  add: (files: File[]) => void;
  /**
   * Empties the composer and resolves once its uploads settle, with where the files that uploaded
   * are kept and the names of those that did not.
   */
  take: () => Promise<{ locations: PiAgentAttachmentLocation[]; failed: string[] }>;
  /** A taken set of files is still uploading. */
  sending: boolean;
  /** Which added files were left out for exceeding the limit, until files are added or taken. */
  refusal: string | null;
};

/** Where `agentName` can receive files, or null when it cannot read them. */
export function agentAttachmentTarget(
  resolvedScope: BackofficeResolvedScope,
  agentName: string,
  permissions: readonly string[],
): AgentAttachmentTarget | null {
  return resolvedScope.kind === "system" || !piAgentReadsUploads(permissions)
    ? null
    : { scope: backofficeRuntimeScopeFromResolvedScope(resolvedScope), agentName };
}

/** Uploads the file to the workspace, or as a blob when the workspace cannot hold it. */
async function uploadAttachment(
  { scope, agentName }: AgentAttachmentTarget,
  file: File,
  onProgress: (fraction: number | null) => void,
): Promise<PiAgentAttachmentLocation> {
  const key = `${piAgentAttachmentsKeyPrefix(agentName)}${crypto.randomUUID()}/${workspaceFileName(file.name)}`;
  if (file.size > BLOB_MAX_SIZE_BYTES) {
    throw new Error(`Files hold at most ${formatBytes(BLOB_MAX_SIZE_BYTES)}.`);
  }
  if (file.size > STATE_FILE_MAX_BYTES) {
    try {
      await uploadLargeFile({
        uploadsPath: largeFileUploadsPath(scope),
        file,
        key,
        onProgress: (progress) => {
          onProgress(progress.phase === "uploading" ? progress.sentBytes / file.size : 1);
        },
      });
    } catch (error) {
      throw new Error(
        `Over ${formatBytes(STATE_FILE_MAX_BYTES)}, too large for the workspace, and not kept as a large file: ${error instanceof Error ? error.message : "the upload failed."}`,
        { cause: error },
      );
    }
    return { kind: "blob", key };
  }
  const result = await createScopedUploadHelpers(scope).createUploadAndTransfer(file, {
    fileKey: key,
    onProgress: ({ bytesUploaded, totalBytes }) => {
      onProgress(totalBytes > 0 ? bytesUploaded / totalBytes : null);
    },
  });
  if (result.kind !== "published") {
    throw new Error("The upload was not saved to the workspace.");
  }
  return { kind: "workspace", path: `/workspace/${result.file.fileKey}` };
}

async function deleteAttachment(
  scope: BackofficeRoutableScope,
  location: PiAgentAttachmentLocation,
) {
  try {
    if (location.kind === "workspace") {
      await createScopedUploadHelpers(scope).deleteFile(location.path.slice("/workspace/".length));
    } else {
      await discardLargeFile(largeFileUploadsPath(scope), location.key);
    }
  } catch (error) {
    // The file only stays behind where it was uploaded; the composer no longer holds it.
    console.error("Could not delete a removed attachment.", error);
  }
}

/** Null for a null target, where the composer offers no files. */
export function useAgentAttachments(target: AgentAttachmentTarget | null): AgentAttachments | null {
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // `take` runs from event handlers, after the attachments it takes have rendered.
  const latest = useRef(attachments);
  useEffect(() => {
    latest.current = attachments;
  }, [attachments]);
  // Where each upload is kept once it settles, or null when it failed or was removed meanwhile.
  const settled = useRef(new Map<string, Promise<PiAgentAttachmentLocation | null>>());
  const removed = useRef(new Set<string>());

  useEffect(
    () => () => {
      for (const { previewUrl } of latest.current) {
        if (previewUrl !== null) {
          URL.revokeObjectURL(previewUrl);
        }
      }
    },
    [],
  );

  const setUpload = useCallback((id: string, upload: Upload) => {
    setAttachments((current) =>
      current.map((attachment) => (attachment.id === id ? { ...attachment, upload } : attachment)),
    );
  }, []);

  const start = useCallback(
    (id: string, file: File) => {
      if (target === null) {
        return;
      }
      setUpload(id, { kind: "uploading", fraction: null });
      settled.current.set(
        id,
        uploadAttachment(target, file, (fraction) => {
          setUpload(id, { kind: "uploading", fraction });
        }).then(
          (location) => {
            if (removed.current.has(id)) {
              void deleteAttachment(target.scope, location);
              return null;
            }
            setUpload(id, { kind: "uploaded", location });
            return location;
          },
          (error: unknown) => {
            setUpload(id, {
              kind: "failed",
              message: error instanceof Error ? error.message : "The upload failed.",
            });
            return null;
          },
        ),
      );
    },
    [target, setUpload],
  );

  const add = useCallback(
    (files: File[]) => {
      // A message carrying more files than it may would be refused only once they all uploaded.
      const room = Math.max(0, PI_AGENT_MAX_ATTACHMENTS - latest.current.length);
      const left = files.slice(room);
      setRefusal(
        left.length === 0
          ? null
          : `A message carries at most ${PI_AGENT_MAX_ATTACHMENTS} files. Not added: ${left.map(({ name }) => name).join(", ")}.`,
      );
      const added = files.slice(0, room).map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
        upload: { kind: "uploading", fraction: null } satisfies Upload,
      }));
      setAttachments((current) => [...current, ...added]);
      for (const { id, file } of added) {
        start(id, file);
      }
    },
    [start],
  );

  const remove = useCallback(
    (attachment: Attachment) => {
      setAttachments((current) => current.filter(({ id }) => id !== attachment.id));
      if (attachment.previewUrl !== null) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
      if (attachment.upload.kind === "uploaded" && target !== null) {
        void deleteAttachment(target.scope, attachment.upload.location);
      } else if (attachment.upload.kind === "uploading") {
        removed.current.add(attachment.id);
      }
    },
    [target],
  );

  const take = useCallback(async () => {
    const taken = latest.current;
    if (taken.length === 0) {
      return { locations: [], failed: [] };
    }
    setAttachments([]);
    setRefusal(null);
    setSending(true);
    const results = await Promise.all(
      taken.map(async ({ id, file }) => ({
        name: file.name,
        location: (await settled.current.get(id)) ?? null,
      })),
    );
    setSending(false);
    for (const { id, previewUrl } of taken) {
      settled.current.delete(id);
      if (previewUrl !== null) {
        URL.revokeObjectURL(previewUrl);
      }
    }
    return {
      locations: results.flatMap(({ location }) => (location === null ? [] : [location])),
      failed: results.flatMap(({ name, location }) => (location === null ? [name] : [])),
    };
  }, []);

  const items = attachments.map(
    (attachment): ChatComposerAttachmentItem => ({
      id: attachment.id,
      file: {
        name: attachment.file.name,
        contentType: attachment.file.type,
        sizeBytes: attachment.file.size,
        previewUrl: attachment.previewUrl,
      },
      upload:
        attachment.upload.kind === "failed"
          ? {
              kind: "failed",
              message: attachment.upload.message,
              onRetry: () => {
                start(attachment.id, attachment.file);
              },
            }
          : attachment.upload.kind === "uploaded"
            ? { kind: "uploaded" }
            : attachment.upload,
      onRemove: () => {
        remove(attachment);
      },
    }),
  );
  return target === null ? null : { items, add, take, sending, refusal };
}

/**
 * A sent message's files: workspace files open in Files, with images shown through the preview
 * route, and blobs download, as large files have no preview.
 */
export function sentAttachmentItems(
  scope: BackofficeResolvedScope,
  attachments: readonly PiAgentAttachment[],
): ChatMessageAttachmentItem[] {
  return attachments.map((attachment) => {
    const { contentType, sizeBytes } = attachment;
    if (attachment.kind === "blob") {
      return {
        id: attachment.key,
        file: {
          name: attachment.key.split("/").at(-1)!,
          contentType,
          sizeBytes,
          previewUrl: null,
        },
        href: largeFileDownloadPath(scope, attachment.key),
      };
    }
    const { path } = attachment;
    return {
      id: path,
      file: {
        name: path.split("/").at(-1)!,
        contentType,
        sizeBytes,
        previewUrl: contentType.startsWith("image/") ? filesPreviewPath(scope, path) : null,
      },
      href: filesExplorerPathFromScopePath(filesScopeBasePath(scope), path),
    };
  });
}
