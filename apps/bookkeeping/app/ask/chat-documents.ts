import {
  PI_AGENT_MAX_ATTACHMENTS,
  type PiAgentAttachment,
} from "@fragno-dev/backoffice-api/v0/pi-conversation/prompt-attachments";
import type {
  ChatComposerAttachmentItem,
  ChatMessageAttachmentItem,
} from "@fragno-private/design-system/agents/chat-attachment";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

type ChatFile = { id: string; file: File; previewUrl: string | null };

/** Uploads `file` as the document `documentId` through `documentsPath`; returns why not, or null. */
async function uploadDocument(documentsPath: string, documentId: string, file: File) {
  const body = new FormData();
  body.set("documentId", documentId);
  body.set("file", file);
  const response = await fetch(documentsPath, {
    method: "POST",
    headers: { accept: "application/json" },
    body,
  }).catch(() => null);
  const answer = z
    .object({ error: z.string().nullable() })
    .safeParse(await response?.json().catch(() => null));
  return answer.success ? answer.data.error : "Bookkeeping could not be reached.";
}

/**
 * The files a message being written carries. They stay in the browser until it is sent, so a file
 * removed before then never reaches the books; sending uploads each as one of the books' documents,
 * which Bookkeeping asks the firm's bookkeeping agent about, as uploads on the documents page.
 */
export function useChatDocuments(documentsPath: string) {
  const [files, setFiles] = useState<readonly ChatFile[]>([]);
  // The files a sent message is uploading; files added meanwhile wait for the next message.
  const [uploading, setUploading] = useState<ReadonlySet<string>>(new Set());
  const [refusal, setRefusal] = useState<string | null>(null);
  // `take` runs from event handlers, after the files it takes have rendered.
  const latest = useRef(files);
  useEffect(() => {
    latest.current = files;
  }, [files]);
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

  const add = useCallback((added: File[]) => {
    // A message carrying more files than it may would be refused only once they all uploaded.
    const room = Math.max(0, PI_AGENT_MAX_ATTACHMENTS - latest.current.length);
    const left = added.slice(room);
    setRefusal(
      left.length === 0
        ? null
        : `A message carries at most ${PI_AGENT_MAX_ATTACHMENTS} files. Not added: ${left.map(({ name }) => name).join(", ")}.`,
    );
    setFiles((current) => [
      ...current,
      ...added.slice(0, room).map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      })),
    ]);
  }, []);

  const remove = useCallback((removed: ChatFile) => {
    setFiles((current) => current.filter(({ id }) => id !== removed.id));
    if (removed.previewUrl !== null) {
      URL.revokeObjectURL(removed.previewUrl);
    }
  }, []);

  /**
   * Takes the files from the composer and uploads them: the IDs of the documents they became, and
   * why the others did not. Each file's ID is its document's, so its upload records it once.
   */
  const take = useCallback(async () => {
    const taken = latest.current;
    if (taken.length === 0) {
      return { documents: [], failed: [] };
    }
    const takenIds = new Set(taken.map(({ id }) => id));
    setUploading(takenIds);
    setRefusal(null);
    const results = await Promise.all(
      taken.map(async ({ id, file }) => ({
        id,
        name: file.name,
        error: await uploadDocument(documentsPath, id, file),
      })),
    );
    setFiles((current) => current.filter(({ id }) => !takenIds.has(id)));
    setUploading(new Set());
    for (const { previewUrl } of taken) {
      if (previewUrl !== null) {
        URL.revokeObjectURL(previewUrl);
      }
    }
    return {
      documents: results.flatMap(({ id, error }) => (error === null ? [id] : [])),
      failed: results.flatMap(({ name, error }) => (error === null ? [] : [`${name}: ${error}`])),
    };
  }, [documentsPath]);

  const items = files.map(
    (chatFile): ChatComposerAttachmentItem => ({
      id: chatFile.id,
      file: {
        name: chatFile.file.name,
        contentType: chatFile.file.type,
        sizeBytes: chatFile.file.size,
        previewUrl: chatFile.previewUrl,
      },
      // A file uploads as the message is sent.
      upload: uploading.has(chatFile.id)
        ? { kind: "uploading", fraction: null }
        : { kind: "uploaded" },
      onRemove: () => {
        remove(chatFile);
      },
    }),
  );
  return { items, add, take, sending: uploading.size > 0, refusal };
}

// Bookkeeping keeps a document's file at `documents/<document ID>/…` in the administration's project.
const DOCUMENT_KEY = /^documents\/([0-9a-f-]{36})\//u;

/** The documents a sent message carried, each opening its page in the books under `base`. */
export function sentDocumentItems(
  attachments: readonly PiAgentAttachment[],
  base: string,
): ChatMessageAttachmentItem[] {
  return attachments.flatMap((attachment) => {
    const documentId = attachment.kind === "blob" ? DOCUMENT_KEY.exec(attachment.key)?.[1] : null;
    if (attachment.kind !== "blob" || documentId == null) {
      return [];
    }
    return [
      {
        id: attachment.key,
        file: {
          name: attachment.key.split("/").at(-1)!,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
          previewUrl: null,
        },
        href: `${base}/documents/${documentId}`,
      },
    ];
  });
}
