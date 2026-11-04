import { z } from "zod";

import { requireBooksSubmission } from "../books/books.server";
import { askBookkeeper } from "../documents/bookkeeper.server";
import { DOCUMENT_MAX_SIZE, readUploadForm, uploadDocument } from "../documents/documents.server";
import type { Route } from "./+types/documents";
import type { BooksAgentAnswer } from "./agent";

const uploadSchema = z.object({
  documentId: z.uuid(),
  file: z.instanceof(File, { message: "Choose a file to upload." }),
});

/**
 * Uploads a file a chat message carries as one of the books' documents, and asks the firm's
 * bookkeeping agent about it, as the documents page does; the message then names it. Uploading
 * again under the same document ID records it once.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const context = await requireBooksSubmission(request, params, "keep");
  const answer = (error: string | null, status = 200) =>
    Response.json({ error } satisfies BooksAgentAnswer, { status });
  const form = await readUploadForm(request);
  if (form === null) {
    return answer(`Upload files of at most ${DOCUMENT_MAX_SIZE}.`, 413);
  }
  const parsed = uploadSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    return answer(parsed.error.issues[0]?.message ?? "Check the upload.", 400);
  }
  const { documentId, file } = parsed.data;
  const uploaded = await uploadDocument(request, context, { id: documentId, file });
  if (!uploaded.ok) {
    return answer(uploaded.error);
  }
  // A request that was not sent shows on the document's page, to ask again.
  await askBookkeeper(context, (await context.books.getDocument(documentId))!, "first");
  return answer(null);
}
