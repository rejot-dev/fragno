import { Buffer } from "node:buffer";

import { BackofficeApiRequestError } from "@fragno-dev/backoffice-api/v0/client";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { DocumentView } from "../../workers/books/documents/documents";
import type { DocumentMediaType } from "../../workers/books/documents/schema";
import type { requireBooks } from "../books/books.server";
import {
  callBackoffice,
  connectAsUser,
  organizationNotFound,
} from "../organizations/access.server";

type BooksContext = Awaited<ReturnType<typeof requireBooks>>;

/**
 * The largest file Backoffice's workspace holds: it keeps each file in one Durable Object SQLite
 * row, which takes at most 2 MB.
 */
export const DOCUMENT_MAX_BYTES = 1_900_000;

/** Room in an upload's body for the form's other fields and the multipart framing. */
const UPLOAD_FORM_OVERHEAD_BYTES = 16 * 1024;

/**
 * The upload form, or null when its body is larger than any upload: the body is read up to that
 * limit, so a member cannot make the Worker hold a large body, file or other fields, before
 * refusing it.
 */
export async function readUploadForm(request: Request): Promise<FormData | null> {
  const limit = DOCUMENT_MAX_BYTES + UPLOAD_FORM_OVERHEAD_BYTES;
  if (Number(request.headers.get("content-length")) > limit || request.body === null) {
    return null;
  }
  const body = new Uint8Array(limit);
  let size = 0;
  const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    if (size + read.value.byteLength > limit) {
      await reader.cancel();
      return null;
    }
    body.set(read.value, size);
    size += read.value.byteLength;
  }
  const headers = { "content-type": request.headers.get("content-type") ?? "" };
  return await new Response(body.subarray(0, size), { headers }).formData();
}

/**
 * Backoffice as the signed-in person, in the administration's project, whose workspace holds its
 * documents' files. Backoffice refusing means they were removed or Bookkeeping was uninstalled
 * since their membership was last confirmed.
 */
async function connectToProject(request: Request, context: BooksContext) {
  const scope: BackofficeContextScope = {
    kind: "project",
    owner: { kind: "org", orgId: context.organization.id, jurisdiction: null },
    projectId: context.administration.id,
  };
  const backoffice = await connectAsUser(request, scope);
  if (!backoffice) {
    throw organizationNotFound();
  }
  return { backoffice, scope };
}

/**
 * Stores an uploaded file in the administration's Backoffice workspace and records it as a
 * document under `id`, which the upload form chose. The file is stored first, so a document always
 * has its file; uploading again after a failure finishes the job and records the document once.
 * Returns why the file was refused instead.
 */
export async function uploadDocument(
  request: Request,
  context: BooksContext,
  upload: { id: string; file: File },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { id, file } = upload;
  if (file.size === 0) {
    return { ok: false, error: "Choose a file to upload." };
  }
  if (file.size > DOCUMENT_MAX_BYTES) {
    return { ok: false, error: "Upload files of at most 1.9 MB." };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = sniffMediaType(bytes);
  if (mediaType === null) {
    return { ok: false, error: "Upload a PDF, or a PNG, JPEG, or WebP image." };
  }
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  // Never overwrite the file of a document recorded under this ID.
  const recorded = await context.books.getDocument(id);
  if (recorded) {
    return recorded.sha256 === sha256
      ? { ok: true }
      : { ok: false, error: "Another file was uploaded with this form. Upload it again." };
  }
  const filename = file.name.trim().slice(0, 255) || "document";
  // Backoffice's writes have no precondition, so the path names the bytes: another file sent with
  // this form at the same time is written beside this one, never over it.
  const storageKey = `/workspace/documents/${id}/${sha256}/${storedFilename(filename)}`;
  const { backoffice, scope } = await connectToProject(request, context);
  try {
    await callBackoffice(() =>
      backoffice.call(scope, "state.writeFileBytes", {
        path: storageKey,
        content: Buffer.from(bytes).toString("base64"),
      }),
    );
  } catch (error) {
    if (error instanceof BackofficeApiRequestError && error.code === "forbidden") {
      return { ok: false, error: `Backoffice did not store the file: ${error.message}` };
    }
    throw error;
  }
  const outcome = await context.books.recordDocument({
    id,
    filename,
    mediaType,
    sizeBytes: bytes.byteLength,
    sha256,
    storageKey,
    uploadedBy: context.user.name,
  });
  return outcome.ok ? { ok: true } : { ok: false, error: outcome.message };
}

/**
 * A document's file as it was uploaded: `changed` when its bytes in Backoffice are no longer the
 * ones uploaded, e.g. someone replaced the file there, and `missing` when it is gone.
 */
export async function readDocumentFile(
  request: Request,
  context: BooksContext,
  document: DocumentView,
): Promise<
  { status: "ok"; bytes: Uint8Array<ArrayBuffer> } | { status: "changed" } | { status: "missing" }
> {
  const { backoffice, scope } = await connectToProject(request, context);
  let content: string;
  try {
    content = await callBackoffice(() =>
      backoffice.call(scope, "state.readFileBytes", { path: document.storageKey }),
    );
  } catch (error) {
    if (error instanceof BackofficeApiRequestError && error.code === "not_found") {
      return { status: "missing" };
    }
    throw error;
  }
  const bytes = new Uint8Array(Buffer.from(content, "base64"));
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  return sha256 === document.sha256 ? { status: "ok", bytes } : { status: "changed" };
}

/** What a file is by its first bytes; the name and type a browser sends are not evidence. */
function sniffMediaType(bytes: Uint8Array): DocumentMediaType | null {
  const startsWith = (signature: number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  const ascii = (text: string) => Array.from(new TextEncoder().encode(text));
  if (startsWith(ascii("%PDF-"))) {
    return "application/pdf";
  }
  if (startsWith([0x89, ...ascii("PNG\r\n"), 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith([0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (startsWith(ascii("RIFF")) && startsWith(ascii("WEBP"), 8)) {
    return "image/webp";
  }
  return null;
}

/** A filename safe in a workspace path: letters, digits, dots, dashes, and underscores. */
function storedFilename(filename: string): string {
  const safe = filename
    .normalize("NFKD")
    .replace(/[^\w.-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(-100);
  return safe || "document";
}
