import { ButtonLink } from "@fragno-private/design-system/button";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfaceCard,
  SurfaceFacts,
  SurfaceSection,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/surface-panel";
import { Link, useOutletContext } from "react-router";
import { z } from "zod";

import type { DocumentView } from "../../workers/books/documents/documents";
import { formatDate } from "../books/books";
import {
  formResult,
  parseForm,
  requireBooks,
  requireBooksSubmission,
  type FormResult,
} from "../books/books.server";
import { FormDialog } from "../books/forms";
import type { BooksOutletContext } from "../books/layout";
import type { Route } from "./+types/document";
import {
  askBookkeeper,
  readBookkeeperProgress,
  type BookkeeperProgress,
} from "./bookkeeper.server";
import { DocumentPreview } from "./preview";
import { ASK, BookkeeperReview } from "./review";
import { documentEntries, DocumentStatus } from "./status";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.document.filename ?? "Document"} · Bookkeeping` }];
}

async function requireDocument(
  context: Awaited<ReturnType<typeof requireBooks>>,
  documentId: string,
) {
  const document = await context.books.getDocument(documentId);
  if (!document) {
    throw new Response("This document does not exist.", { status: 404 });
  }
  return document;
}

/** The document, and how far the bookkeeping agent got with a request still unanswered. */
async function documentWithProgress(
  context: Awaited<ReturnType<typeof requireBooks>>,
  documentId: string,
): Promise<{ document: DocumentView; progress: BookkeeperProgress | null }> {
  const document = await requireDocument(context, documentId);
  const { review } = document;
  if (document.state.status !== "to-book" || review?.status !== "requested") {
    return { document, progress: null };
  }
  const progress = await readBookkeeperProgress(context, review.requestId);
  if (["queued", "running", "unknown"].includes(progress.status)) {
    return { document, progress };
  }
  // The agent answers before its turn ends, so a turn that ended may have answered since.
  const reread = await requireDocument(context, documentId);
  if (reread.review?.status === "requested" && reread.review.requestId === review.requestId) {
    return { document: reread, progress };
  }
  return await documentWithProgress(context, documentId);
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await requireBooks(request, params);
  return await documentWithProgress(context, params.documentId);
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const DISMISS = "dismiss";

/**
 * Dismisses the document, such as a duplicate, so it no longer waits to be booked; or asks the
 * bookkeeping agent, again, to propose its entry.
 */
export async function action({ request, params }: Route.ActionArgs): Promise<FormResult> {
  const context = await requireBooksSubmission(request, params, "keep");
  const parsed = await parseForm(request, z.object({ intent: z.enum([DISMISS, ASK]) }));
  if ("refusal" in parsed) {
    return parsed.refusal;
  }
  if (parsed.data.intent === ASK) {
    const asked = await askBookkeeper(
      context,
      await requireDocument(context, params.documentId),
      "again",
    );
    return { intent: ASK, error: asked.ok ? null : asked.error };
  }
  return formResult(
    DISMISS,
    await context.books.dismissDocument({
      documentId: params.documentId,
      dismissedBy: context.user.name,
    }),
  );
}

const ENTRY_COLUMNS = [
  { label: "Entry", align: "start" },
  { label: "Date", align: "start" },
  { label: "", align: "end" },
] as const;

const MEDIA_TYPE_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
  "image/webp": "WebP image",
};

export default function DocumentPage({ loaderData, actionData }: Route.ComponentProps) {
  const context = useOutletContext<BooksOutletContext>();
  const { base } = context;
  const { document, progress } = loaderData;
  const { state } = document;
  const entries = documentEntries(document, context);
  const entryNames = new Map(entries.map((entry) => [entry.id, entry.name]));
  return (
    <>
      <PageHeading
        eyebrow={
          <Link to={`${base}/documents`} className="hover:underline">
            Documents
          </Link>
        }
        title={document.filename}
        meta={null}
        actions={
          state.status === "to-book" ? (
            <>
              <FormDialog
                label="Dismiss"
                variant="ghost"
                title={`Dismiss ${document.filename}`}
                description="Dismiss a document that is not to be booked, such as a duplicate. It stays listed, and its file stays in Backoffice."
                intent={DISMISS}
                resultIntent={DISMISS}
                submit="Dismiss"
                result={actionData}
              >
                {null}
              </FormDialog>
              <ButtonLink variant="solid" to={`${base}/entries/new?document=${document.id}`}>
                {document.review?.status === "proposed"
                  ? "Review and book"
                  : entries.length === 0
                    ? "Book"
                    : "Book again"}
              </ButtonLink>
            </>
          ) : null
        }
      />
      <SurfaceCard>
        <SurfaceFacts
          items={[
            {
              key: "status",
              label: "Status",
              value: <DocumentStatus document={document} context={context} />,
            },
            {
              key: "uploaded",
              label: "Uploaded",
              value: `${formatDate(document.uploadedAt.toISOString().slice(0, 10))} by ${document.uploadedBy}`,
            },
            {
              key: "file",
              label: "File",
              value: `${MEDIA_TYPE_LABELS[document.mediaType]}, ${Math.ceil(document.sizeBytes / 1000)} kB`,
            },
            ...(state.status === "dismissed"
              ? [
                  {
                    key: "dismissed",
                    label: "Dismissed",
                    value: `${formatDate(state.at.slice(0, 10))} by ${state.by}`,
                  },
                ]
              : []),
            ...(document.source === null
              ? []
              : [
                  {
                    key: "date",
                    label: "Document date",
                    value: formatDate(document.source.documentDate),
                  },
                ]),
          ]}
        />
      </SurfaceCard>
      {entries.length === 0 ? null : (
        <SurfaceSection
          title="Entries"
          meta={entries.length === 1 ? "1 entry" : `${entries.length} entries`}
          actions={null}
        >
          <SurfaceTable columns={ENTRY_COLUMNS}>
            {entries.map((entry) => (
              <SurfaceTableRow
                key={entry.id}
                columns={ENTRY_COLUMNS}
                cells={[
                  <Link
                    key="entry"
                    to={entry.path}
                    className="font-semibold text-[var(--bo-fg)] tabular-nums hover:underline"
                  >
                    {entry.name}
                  </Link>,
                  <span key="date" className="tabular-nums">
                    {formatDate(entry.postingDate)}
                  </span>,
                  entry.reversedByEntryId !== null ? (
                    <BackofficeStatusLight key="status" tone="waiting">
                      Reversed by {entryNames.get(entry.reversedByEntryId)}
                    </BackofficeStatusLight>
                  ) : entry.reversesEntryId !== null ? (
                    <BackofficeStatusLight key="status" tone="muted">
                      Reverses {entryNames.get(entry.reversesEntryId)}
                    </BackofficeStatusLight>
                  ) : null,
                ]}
              />
            ))}
          </SurfaceTable>
        </SurfaceSection>
      )}
      {state.status === "to-book" ? (
        <BookkeeperReview
          document={document}
          progress={progress}
          context={context}
          result={actionData}
        />
      ) : null}
      <DocumentPreview base={base} document={document} />
    </>
  );
}
