import { requireBooks } from "../books/books.server";
import type { Route } from "./+types/document-file";
import { readDocumentFile } from "./documents.server";

const PRIVATE = { "Cache-Control": "private, no-store" };

/**
 * A document's file, as it was uploaded, for the pages to show and people to download. Only files
 * sniffed as PDFs and images are stored, never markup, and `nosniff` keeps browsers from reading
 * them as anything else. No sandbox policy: browsers refuse to show PDFs under one.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await requireBooks(request, params);
  const document = await context.books.getDocument(params.documentId);
  if (!document) {
    throw new Response("This document does not exist.", { status: 404 });
  }
  const file = await readDocumentFile(request, context, document);
  if (file.status === "missing") {
    return explanation(404, "This document's file is no longer in Backoffice.");
  }
  if (file.status === "changed") {
    return explanation(
      409,
      "This document's file was changed in Backoffice after it was uploaded, so Bookkeeping no longer shows it.",
    );
  }
  return new Response(file.bytes, {
    headers: {
      ...PRIVATE,
      "Content-Type": document.mediaType,
      "Content-Length": String(file.bytes.byteLength),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(document.filename)}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function explanation(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { ...PRIVATE, "Content-Type": "text/plain; charset=utf-8" },
  });
}
