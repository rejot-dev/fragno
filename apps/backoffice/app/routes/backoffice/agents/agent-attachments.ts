import { piAgentPermissionGrantRequirements } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type {
  ChatComposerAttachmentItem,
  ChatMessageAttachmentItem,
} from "@fragno-private/design-system/chat-attachment";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import {
  PI_AGENT_MAX_ATTACHMENTS,
  piAgentAttachmentsFolder,
  type PiAgentAttachment,
} from "@/fragno/pi/agent/pi-agent-attachments";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";
import { createScopedUploadHelpers } from "@/fragno/upload-client";
import { workspaceFileName } from "@/lib/workspace-file-name";
import {
  filesExplorerPathFromScopePath,
  filesPreviewPath,
  filesScopeBasePath,
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
  | { kind: "uploaded"; path: string }
  | { kind: "failed"; message: string };

type Attachment = { id: string; file: File; previewUrl: string | null; upload: Upload };

/** Where an agent's composer uploads the files its messages carry. */
export type AgentAttachmentTarget = { scope: BackofficeRoutableScope; agentName: string };

/** The files waiting in a composer, which upload as soon as they are added. */
export type AgentAttachments = {
  items: ChatComposerAttachmentItem[];
  add: (files: File[]) => void;
  /**
   * Empties the composer and resolves once its uploads settle, with the paths of the files that
   * uploaded and the names of those that did not.
   */
  take: () => Promise<{ paths: string[]; failed: string[] }>;
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

async function uploadAttachment(
  { scope, agentName }: AgentAttachmentTarget,
  file: File,
  onProgress: (fraction: number | null) => void,
): Promise<string> {
  const folder = piAgentAttachmentsFolder(agentName).slice("/workspace/".length);
  const result = await createScopedUploadHelpers(scope).createUploadAndTransfer(file, {
    fileKey: `${folder}${crypto.randomUUID()}/${workspaceFileName(file.name)}`,
    onProgress: ({ bytesUploaded, totalBytes }) => {
      onProgress(totalBytes > 0 ? bytesUploaded / totalBytes : null);
    },
  });
  if (result.kind !== "published") {
    throw new Error("The upload was not saved to the workspace.");
  }
  return `/workspace/${result.file.fileKey}`;
}

async function deleteAttachment(scope: BackofficeRoutableScope, path: string) {
  try {
    await createScopedUploadHelpers(scope).deleteFile(path.slice("/workspace/".length), {
      provider: UPLOAD_PROVIDER_DATABASE,
    });
  } catch (error) {
    // The file only stays behind in the workspace; the composer no longer holds it.
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
  // Each upload's path once it settles, or null when it failed or was removed meanwhile.
  const settled = useRef(new Map<string, Promise<string | null>>());
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
          (path) => {
            if (removed.current.has(id)) {
              void deleteAttachment(target.scope, path);
              return null;
            }
            setUpload(id, { kind: "uploaded", path });
            return path;
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
        void deleteAttachment(target.scope, attachment.upload.path);
      } else if (attachment.upload.kind === "uploading") {
        removed.current.add(attachment.id);
      }
    },
    [target],
  );

  const take = useCallback(async () => {
    const taken = latest.current;
    if (taken.length === 0) {
      return { paths: [], failed: [] };
    }
    setAttachments([]);
    setRefusal(null);
    setSending(true);
    const results = await Promise.all(
      taken.map(async ({ id, file }) => ({
        name: file.name,
        path: (await settled.current.get(id)) ?? null,
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
      paths: results.flatMap(({ path }) => (path === null ? [] : [path])),
      failed: results.flatMap(({ name, path }) => (path === null ? [name] : [])),
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

/** A sent message's files, each opening in Files; images show through the preview route. */
export function sentAttachmentItems(
  scope: BackofficeResolvedScope,
  attachments: readonly PiAgentAttachment[],
): ChatMessageAttachmentItem[] {
  return attachments.map(({ path, contentType, sizeBytes }) => ({
    id: path,
    file: {
      name: path.split("/").at(-1)!,
      contentType,
      sizeBytes,
      previewUrl: contentType.startsWith("image/") ? filesPreviewPath(scope, path) : null,
    },
    href: filesExplorerPathFromScopePath(filesScopeBasePath(scope), path),
  }));
}
