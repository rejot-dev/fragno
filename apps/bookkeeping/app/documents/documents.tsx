import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { FileInput } from "@fragno-private/design-system/file-input";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import {
  SurfaceCard,
  SurfacePanelBody,
  SurfacePanelFooter,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Form, Link, redirect, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import { booksPath, documentPath, formatDate } from "../books/books";
import { requireBooks, requireBooksSubmission, type FormResult } from "../books/books.server";
import { FormError } from "../books/forms";
import type { BooksOutletContext } from "../books/layout";
import type { Route } from "./+types/documents";
import { readUploadForm, uploadDocument } from "./documents.server";
import { DocumentStatus } from "./status";

export function meta() {
  return [{ title: "Documents · Bookkeeping" }];
}

/**
 * The books' documents, newest first. The upload form carries an ID chosen when it was shown, so
 * uploading again after a failure records the document once.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { books } = await requireBooks(request, params);
  const cursor = new URL(request.url).searchParams.get("cursor");
  return {
    documents: await books.listDocuments({ cursor }),
    paged: cursor !== null,
    documentId: crypto.randomUUID(),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const UPLOAD = "upload";

const uploadSchema = z.object({
  intent: z.literal(UPLOAD),
  documentId: z.uuid(),
  file: z.instanceof(File, { message: "Choose a file to upload." }),
});

/** Uploads a document, then opens it to book it. */
export async function action({ request, params }: Route.ActionArgs): Promise<FormResult> {
  const context = await requireBooksSubmission(request, params, "keep");
  const form = await readUploadForm(request);
  if (form === null) {
    return { intent: UPLOAD, error: "Upload files of at most 1.9 MB." };
  }
  const parsed = uploadSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    return { intent: UPLOAD, error: parsed.error.issues[0]?.message ?? "Check the form." };
  }
  const { documentId, file } = parsed.data;
  const uploaded = await uploadDocument(request, context, { id: documentId, file });
  if (!uploaded.ok) {
    return { intent: UPLOAD, error: uploaded.error };
  }
  throw redirect(documentPath(booksPath(params), documentId));
}

const COLUMNS = [
  { label: "Document", align: "start" },
  { label: "Uploaded", align: "start" },
  { label: "By", align: "start" },
  { label: "Status", align: "start" },
] as const;

export default function DocumentsPage({ loaderData, actionData }: Route.ComponentProps) {
  const context = useOutletContext<BooksOutletContext>();
  const { books, base } = context;
  const navigation = useNavigation();
  const { documents, paged } = loaderData;
  const documentsPath = `${base}/documents`;
  return (
    <>
      <PageHeading eyebrow={books.name} title="Documents" meta={null} actions={null} />
      <SurfaceCard>
        <Form method="post" encType="multipart/form-data">
          <SurfacePanelBody>
            <input type="hidden" name="intent" value={UPLOAD} />
            <input type="hidden" name="documentId" value={loaderData.documentId} />
            <div className="flex flex-wrap items-end gap-3">
              <Field
                label="Upload a document"
                description="An invoice or receipt: a PDF, or a PNG, JPEG, or WebP image of at most 1.9 MB."
                className="min-w-64 flex-1"
              >
                <FileInput
                  name="file"
                  accept="application/pdf,image/png,image/jpeg,image/webp"
                  required
                />
              </Field>
              <Button type="submit" variant="solid" disabled={navigation.state !== "idle"}>
                Upload
              </Button>
            </div>
            <FormError result={actionData} intent={UPLOAD} />
          </SurfacePanelBody>
        </Form>
      </SurfaceCard>
      <SurfaceCard>
        {documents.items.length === 0 ? (
          <BackofficeSystemState
            flush
            tone="empty"
            label="Documents"
            title="No documents yet"
            description="Upload invoices and receipts to book them. They show here, newest first."
          />
        ) : (
          <SurfaceTable columns={COLUMNS}>
            {documents.items.map((document) => (
              <SurfaceTableRow
                key={document.id}
                columns={COLUMNS}
                cells={[
                  <Link
                    key="document"
                    to={documentPath(base, document.id)}
                    className="font-medium text-[var(--bo-fg)] hover:underline"
                  >
                    {document.filename}
                  </Link>,
                  <span key="uploaded" className="tabular-nums">
                    {formatDate(document.uploadedAt.toISOString().slice(0, 10))}
                  </span>,
                  document.uploadedBy,
                  <DocumentStatus key="status" document={document} context={context} />,
                ]}
              />
            ))}
          </SurfaceTable>
        )}
        {documents.cursor !== null || paged ? (
          <SurfacePanelFooter>
            {paged ? (
              <ButtonLink variant="ghost" to={documentsPath}>
                Newest documents
              </ButtonLink>
            ) : null}
            {documents.cursor !== null ? (
              <ButtonLink variant="secondary" to={`${documentsPath}?cursor=${documents.cursor}`}>
                Older documents
              </ButtonLink>
            ) : null}
          </SurfacePanelFooter>
        ) : null}
      </SurfaceCard>
    </>
  );
}
