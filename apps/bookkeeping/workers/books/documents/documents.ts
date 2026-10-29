import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase, type FragnoPublicConfigWithDatabase, type TxResult } from "@fragno-dev/db";
import type { createLedgerFragment } from "@fragno-dev/ledger";

import {
  documentsSchema,
  type Dismissal,
  type DocumentMediaType,
  type Review,
  type ReviewAnswer,
  type ReviewRequest,
} from "./schema";

type LedgerServices = ReturnType<typeof createLedgerFragment>["services"];
type PostEntryInput = Parameters<LedgerServices["postEntry"]>[0];
type ReverseEntryInput = Parameters<LedgerServices["reverseEntry"]>[0];
type Result<T> = T extends TxResult<infer TResult, infer _TRetrieved> ? TResult : never;
type SourceDocument = Result<ReturnType<LedgerServices["getSourceDocuments"]>>[number];
type SourceEntry = SourceDocument["entries"][number];

/** The ledger kind of the source documents that documents are. */
export const DOCUMENT_SOURCE_KIND = "document";

const PAGE_SIZE = 50;

const documentErrorMessages = {
  DOCUMENT_NOT_FOUND: "This document does not exist.",
  DOCUMENT_ID_TAKEN: "Another file was uploaded with this form. Upload it again.",
  DOCUMENT_BOOKED: "This document is booked. Reverse its entry first.",
  DOCUMENT_DISMISSED: "This document was dismissed.",
  REQUEST_NOT_AWAITED:
    "This request no longer awaits an answer: the document was answered, or asked about again, since.",
} as const;

export type DocumentErrorCode = keyof typeof documentErrorMessages;

/** Thrown by services when an operation does not fit the document; aborts the whole transaction. */
export class DocumentError extends Error {
  readonly code: DocumentErrorCode;

  constructor(code: DocumentErrorCode) {
    super(documentErrorMessages[code]);
    this.name = "DocumentError";
    this.code = code;
  }
}

export type NewDocument = {
  /** Chosen by the uploader, so uploading again after a failure records the document once. */
  id: string;
  filename: string;
  mediaType: DocumentMediaType;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  uploadedBy: string;
};

/**
 * Where a document stands: booked while an entry booking it is in effect, i.e. not reversed; to
 * book again once every such entry is reversed.
 */
export type DocumentState =
  | { status: "to-book" }
  | { status: "booked"; entryId: string }
  | ({ status: "dismissed" } & Dismissal);

export type DocumentView = NewDocument & {
  uploadedAt: Date;
  review: Review | null;
  /** Whether its file may still be shared with a firm's bookkeeping agent. */
  shared: boolean;
  /** The ledger's source document, once an entry recorded it, with every entry recording it. */
  source: SourceDocument | null;
  state: DocumentState;
};

type DocumentRow = Omit<DocumentView, "source" | "state"> & { dismissal: Dismissal | null };

/**
 * Whether an entry books its document: an entry recording it does, its reversal undoes that, and
 * reversing the reversal books it again. A reversal records its entry's source document, so the
 * whole chain is among the source document's entries.
 */
function booksDocument(entry: SourceEntry, source: SourceDocument): boolean {
  let books = true;
  let current = entry;
  while (current.reversesEntryId !== null) {
    const reversed = current.reversesEntryId;
    books = !books;
    current = source.entries.find((candidate) => candidate.id === reversed)!;
  }
  return books;
}

function documentState(dismissal: Dismissal | null, source: SourceDocument | null): DocumentState {
  if (dismissal !== null) {
    return { status: "dismissed", ...dismissal };
  }
  const inEffect = source?.entries.find(
    (entry) => entry.reversedByEntryId === null && booksDocument(entry, source),
  );
  return inEffect ? { status: "booked", entryId: inEffect.id } : { status: "to-book" };
}

/** The request a document to book awaits an answer to, if any. */
function awaitedRequest(
  document: { dismissal: Dismissal | null; review: Review | null },
  source: SourceDocument | null,
): string | null {
  const { review } = document;
  return review?.status === "requested" &&
    documentState(document.dismissal, source).status === "to-book"
    ? review.requestId
    : null;
}

/** Refuses booking a document that is booked or dismissed. */
function assertToBook(state: DocumentState) {
  if (state.status === "dismissed") {
    throw new DocumentError("DOCUMENT_DISMISSED");
  }
  if (state.status === "booked") {
    throw new DocumentError("DOCUMENT_BOOKED");
  }
}

/** A document with what the ledger records of it. */
export function describeDocument(row: DocumentRow, source: SourceDocument | null): DocumentView {
  const { dismissal, ...document } = row;
  return { ...document, source, state: documentState(dismissal, source) };
}

function toRow(document: {
  id: { valueOf(): string };
  filename: string;
  mediaType: DocumentMediaType;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  uploadedAt: Date;
  uploadedBy: string;
  dismissal: Dismissal | null;
  review: Review | null;
  shared: boolean;
}): DocumentRow {
  return {
    id: document.id.valueOf(),
    filename: document.filename,
    mediaType: document.mediaType,
    sizeBytes: document.sizeBytes,
    sha256: document.sha256,
    storageKey: document.storageKey,
    uploadedAt: document.uploadedAt,
    uploadedBy: document.uploadedBy,
    dismissal: document.dismissal,
    review: document.review,
    shared: document.shared,
  };
}

/**
 * Documents uploaded to an administration's books, booked through its ledger in the same
 * transaction, so a document is booked and dismissed by the rules of both.
 */
const documentsFragmentDefinition = defineFragment("documents")
  .extend(withDatabase(documentsSchema))
  .usesService<"ledger", LedgerServices>("ledger")
  .providesBaseService(({ defineService, serviceDeps }) =>
    defineService({
      /** Records an uploaded document; recording the same one again does nothing. */
      recordDocument: function (document: NewDocument) {
        return this.serviceTx(documentsSchema)
          .retrieve((uow) =>
            uow.findFirst("document", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", document.id)),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing] }) => {
            if (existing) {
              if (existing.sha256 !== document.sha256) {
                throw new DocumentError("DOCUMENT_ID_TAKEN");
              }
              return;
            }
            uow.create(
              "document",
              {
                ...document,
                uploadedAt: uow.now(),
                bookings: 0,
                dismissal: null,
                review: null,
                shared: false,
              },
              // A concurrent upload recorded it: retrying reads it and compares the files. Its ID is
              // the table's only unique key.
              { retryOnUniqueConflict: () => true },
            );
          })
          .build();
      },

      /** A page of documents, newest first, without what the ledger records of them. */
      listDocuments: function (input: { cursor: string | null }) {
        return this.serviceTx(documentsSchema)
          .retrieve((uow) =>
            uow.findWithCursor("document", (b) => {
              const page = b
                .whereIndex("idx_document_uploaded")
                .orderByIndex("idx_document_uploaded", "desc")
                .pageSize(PAGE_SIZE);
              return input.cursor ? page.after(input.cursor) : page;
            }),
          )
          .transformRetrieve(([page]) => ({
            cursor: page.hasNextPage ? (page.cursor?.encode() ?? null) : null,
            items: page.items.map(toRow),
          }))
          .build();
      },

      getDocument: function (id: string) {
        return this.serviceTx(documentsSchema)
          .withServiceCalls(() => [serviceDeps.ledger.getSourceDocuments({ ids: [id] })] as const)
          .retrieve((uow) =>
            uow.findFirst("document", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id))),
          )
          .transformRetrieve(([document], [sources]): DocumentView | null =>
            document ? describeDocument(toRow(document), sources[0] ?? null) : null,
          )
          .build();
      },

      /**
       * Posts an entry recording the document: its first, which creates its source document, or
       * one after every earlier entry was reversed. A dismissed document is not booked.
       */
      bookDocument: function (input: {
        documentId: string;
        source: { type: "new"; documentDate: string; description: string } | { type: "existing" };
        entry: Omit<PostEntryInput, "source">;
      }) {
        const { documentId } = input;
        return this.serviceTx(documentsSchema)
          .withServiceCalls(
            () =>
              [
                serviceDeps.ledger.getSourceDocuments({ ids: [documentId] }),
                serviceDeps.ledger.postEntry({
                  ...input.entry,
                  source:
                    input.source.type === "new"
                      ? { ...input.source, id: documentId, kind: DOCUMENT_SOURCE_KIND }
                      : { type: "existing", id: documentId },
                }),
              ] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("document", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", documentId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [document], serviceIntermediateResult: [sources] }) => {
            if (!document) {
              throw new DocumentError("DOCUMENT_NOT_FOUND");
            }
            assertToBook(documentState(document.dismissal, sources[0] ?? null));
            uow.update("document", document.id, (b) =>
              b.set({ bookings: document.bookings + 1 }).check(),
            );
          })
          .transform(({ serviceResult: [, posted] }) => posted)
          .build();
      },

      /**
       * Reverses an entry recording the document. Reversing a reversal books the document again,
       * so it is refused like booking: unless the document is to book.
       */
      reverseDocumentEntry: function (input: { documentId: string; reversal: ReverseEntryInput }) {
        const { documentId, reversal } = input;
        return this.serviceTx(documentsSchema)
          .withServiceCalls(
            () =>
              [
                serviceDeps.ledger.getSourceDocuments({ ids: [documentId] }),
                serviceDeps.ledger.reverseEntry(reversal),
              ] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("document", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", documentId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [document], serviceIntermediateResult: [sources] }) => {
            const source = sources[0];
            const entry = source?.entries.find((candidate) => candidate.id === reversal.entryId);
            if (!document || !entry) {
              throw new DocumentError("DOCUMENT_NOT_FOUND");
            }
            if (booksDocument(entry, source)) {
              return;
            }
            assertToBook(documentState(document.dismissal, source));
            uow.update("document", document.id, (b) =>
              b.set({ bookings: document.bookings + 1 }).check(),
            );
          })
          .transform(({ serviceResult: [, reversed] }) => reversed)
          .build();
      },

      /**
       * Records that the bookkeeping agent was asked to review a document to book, and that its file
       * may be shared with it. Asking again replaces an earlier answer, and recording a request again
       * does nothing; with `first`, so does a request for a document that has a review. Returns the
       * review in effect.
       */
      requestReview: function (input: {
        documentId: string;
        request: ReviewRequest;
        first: boolean;
      }) {
        const { documentId, request, first } = input;
        return this.serviceTx(documentsSchema)
          .withServiceCalls(
            () => [serviceDeps.ledger.getSourceDocuments({ ids: [documentId] })] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("document", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", documentId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [document], serviceIntermediateResult: [sources] }) => {
            if (!document) {
              throw new DocumentError("DOCUMENT_NOT_FOUND");
            }
            assertToBook(documentState(document.dismissal, sources[0] ?? null));
            const current = document.review;
            if (
              current !== null &&
              (first || (current.status === "requested" && current.requestId === request.requestId))
            ) {
              return current;
            }
            uow.update("document", document.id, (b) =>
              b.set({ review: request, shared: true }).check(),
            );
            return request;
          })
          .build();
      },

      /**
       * Records an answer to a document's review. An answer to `request` counts only while the
       * document awaits that request's answer, so a request asked again, or answered, takes no
       * late answer to it; an answer to no request replaces any review.
       */
      answerReview: function (input: {
        documentId: string;
        request: string | null;
        answer: ReviewAnswer;
      }) {
        const { documentId, request, answer } = input;
        return this.serviceTx(documentsSchema)
          .withServiceCalls(
            () => [serviceDeps.ledger.getSourceDocuments({ ids: [documentId] })] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("document", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", documentId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [document], serviceIntermediateResult: [sources] }) => {
            if (!document) {
              throw new DocumentError("DOCUMENT_NOT_FOUND");
            }
            assertToBook(documentState(document.dismissal, sources[0] ?? null));
            const current = document.review;
            if (
              request !== null &&
              !(current?.status === "requested" && current.requestId === request)
            ) {
              throw new DocumentError("REQUEST_NOT_AWAITED");
            }
            uow.update("document", document.id, (b) => b.set({ review: answer }).check());
            return answer;
          })
          .build();
      },

      /**
       * Records that the document's shares were revoked, unless a request awaits an answer, which
       * may have reused a share the revoker revoked. Returns that request, for the revoker to share
       * the file again for it, or null.
       */
      recordSharesRevoked: function (input: { documentId: string }) {
        const { documentId } = input;
        return this.serviceTx(documentsSchema)
          .withServiceCalls(
            () => [serviceDeps.ledger.getSourceDocuments({ ids: [documentId] })] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("document", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", documentId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [document], serviceIntermediateResult: [sources] }) => {
            if (!document) {
              throw new DocumentError("DOCUMENT_NOT_FOUND");
            }
            const awaited = awaitedRequest(document, sources[0] ?? null);
            if (awaited === null) {
              uow.update("document", document.id, (b) => b.set({ shared: false }).check());
            }
            return awaited;
          })
          .build();
      },

      /**
       * Records that the document's file is shared for `requestId`, after sharing it: a revocation
       * may have recorded it unshared meanwhile. Returns whether the request still awaits an answer;
       * when it does not, its sharer revokes the share again.
       */
      recordShared: function (input: { documentId: string; requestId: string }) {
        const { documentId, requestId } = input;
        return this.serviceTx(documentsSchema)
          .withServiceCalls(
            () => [serviceDeps.ledger.getSourceDocuments({ ids: [documentId] })] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("document", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", documentId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [document], serviceIntermediateResult: [sources] }) => {
            if (!document) {
              throw new DocumentError("DOCUMENT_NOT_FOUND");
            }
            uow.update("document", document.id, (b) => b.set({ shared: true }).check());
            return awaitedRequest(document, sources[0] ?? null) === requestId;
          })
          .build();
      },

      /** Sets aside a document that is not booked, such as a duplicate; dismissing it again does nothing. */
      dismissDocument: function (input: { documentId: string; dismissedBy: string }) {
        const { documentId } = input;
        return this.serviceTx(documentsSchema)
          .withServiceCalls(
            () => [serviceDeps.ledger.getSourceDocuments({ ids: [documentId] })] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("document", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", documentId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [document], serviceIntermediateResult: [sources] }) => {
            if (!document) {
              throw new DocumentError("DOCUMENT_NOT_FOUND");
            }
            const state = documentState(document.dismissal, sources[0] ?? null);
            if (state.status === "dismissed") {
              return;
            }
            if (state.status === "booked") {
              throw new DocumentError("DOCUMENT_BOOKED");
            }
            uow.update("document", document.id, (b) =>
              b.set({ dismissal: { by: input.dismissedBy, at: new Date().toISOString() } }).check(),
            );
          })
          .build();
      },
    }),
  )
  .build();

export function createDocumentsFragment(
  options: FragnoPublicConfigWithDatabase,
  services: { ledger: LedgerServices },
) {
  return instantiate(documentsFragmentDefinition)
    .withConfig({})
    .withOptions(options)
    .withServices(services)
    .build();
}
