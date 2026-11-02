import { Buffer } from "node:buffer";

import {
  BackofficeApiRequestError,
  type BackofficeApiClient,
} from "@fragno-dev/backoffice-api/v0/client";
import { MODELS_EXTRACT_FILE_LIMITS } from "@fragno-dev/backoffice-api/v0/models";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { DocumentView } from "../../workers/books/documents/documents";
import type { DocumentMediaType } from "../../workers/books/documents/schema";
import type { requireBooks } from "../books/books.server";
import {
  backofficeUnavailable,
  callBackoffice,
  connectAsUser,
  organizationNotFound,
} from "../organizations/access.server";

type BooksContext = Awaited<ReturnType<typeof requireBooks>>;

/**
 * The largest document: the most the firm's bookkeeping agent reads of one, as `models.extract`
 * reads at most this in a call. Documents are blobs, which hold far more.
 */
const DOCUMENT_MAX_BYTES = MODELS_EXTRACT_FILE_LIMITS.totalBytes;

/** The limit in MiB, which people read as MB. */
export const DOCUMENT_MAX_SIZE = `${DOCUMENT_MAX_BYTES / 1024 ** 2} MB`;

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
  const body = await readUpTo(request.body, limit);
  if (body === null) {
    return null;
  }
  const headers = { "content-type": request.headers.get("content-type") ?? "" };
  return await new Response(body, { headers }).formData();
}

/** A body's bytes, or null once it holds more than `limit`, having read no further. */
async function readUpTo(
  stream: ReadableStream,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const body = new Uint8Array(limit);
  let size = 0;
  const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    if (size + read.value.byteLength > limit) {
      await reader.cancel();
      return null;
    }
    body.set(read.value, size);
    size += read.value.byteLength;
  }
  return body.slice(0, size);
}

/**
 * Presigned storage URLs reach Backoffice's storage rather than Backoffice, so its client does not
 * report them unreachable; this does, as it does Backoffice.
 */
async function fetchFromStorage(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof TypeError) {
      throw backofficeUnavailable();
    }
    throw error;
  }
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
 * Stores an uploaded file as a blob of the administration's Backoffice project and records it as a
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
    return { ok: false, error: `Upload files of at most ${DOCUMENT_MAX_SIZE}.` };
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
  // Backoffice's writes have no precondition, so the key names the bytes: another file sent with
  // this form at the same time is stored beside this one, never over it.
  const storageKey = `documents/${id}/${sha256}/${storedFilename(filename)}`;
  const { backoffice, scope } = await connectToProject(request, context);
  try {
    const stored = await storeBlob(backoffice, scope, { key: storageKey, mediaType, bytes });
    if (!stored.ok) {
      return stored;
    }
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
 * Stores `bytes` as the project's blob `key`: Backoffice hands out a URL its storage takes the
 * bytes at, so they never pass through Backoffice, and completing the upload makes the blob.
 */
async function storeBlob(
  backoffice: BackofficeApiClient,
  scope: BackofficeContextScope,
  blob: { key: string; mediaType: DocumentMediaType; bytes: Uint8Array<ArrayBuffer> },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const upload = await callBackoffice(() =>
    backoffice.call(scope, "blobs.createUpload", { key: blob.key, contentType: blob.mediaType }),
  );
  const stored = await fetchFromStorage(upload.url, {
    method: "PUT",
    headers: upload.headers,
    body: blob.bytes,
  });
  if (!stored.ok) {
    return { ok: false, error: `Backoffice's storage did not take the file (${stored.status}).` };
  }
  await callBackoffice(() =>
    backoffice.call(scope, "blobs.completeUpload", { uploadId: upload.uploadId }),
  );
  return { ok: true };
}

/**
 * A document's file as it was uploaded: `changed` when its bytes in Backoffice are no longer the
 * ones uploaded, e.g. someone replaced the blob there, and `missing` when it is gone. The bytes
 * come straight from Backoffice's storage, read no further than the document's size.
 */
export async function readDocumentFile(
  request: Request,
  context: BooksContext,
  document: DocumentView,
): Promise<
  { status: "ok"; bytes: Uint8Array<ArrayBuffer> } | { status: "changed" } | { status: "missing" }
> {
  const { backoffice, scope } = await connectToProject(request, context);
  const key = document.storageKey;
  const blob = await callBackoffice(() => backoffice.call(scope, "blobs.get", { key }));
  if (blob === null) {
    return { status: "missing" };
  }
  if (blob.sizeBytes !== document.sizeBytes) {
    return { status: "changed" };
  }
  const { url } = await callBackoffice(() =>
    backoffice.call(scope, "blobs.createDownloadUrl", { key }),
  );
  const response = await fetchFromStorage(url);
  if (response.status === 404) {
    return { status: "missing" };
  }
  if (!response.ok || response.body === null) {
    throw backofficeUnavailable();
  }
  // The blob may have been replaced since Backoffice described it.
  const bytes = await readUpTo(response.body, document.sizeBytes);
  if (bytes === null) {
    return { status: "changed" };
  }
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

/** A filename safe in a blob key: letters, digits, dots, dashes, and underscores. */
function storedFilename(filename: string): string {
  const safe = filename
    .normalize("NFKD")
    .replace(/[^\w.-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(-100);
  return safe || "document";
}
