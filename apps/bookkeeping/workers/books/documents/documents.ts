import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import type { createLedgerFragment } from "@fragno-dev/ledger";

import type { createProposalsFragment } from "../proposals/proposals";
import type { AgentProposal, ProposalAnswer, ProposalRequest } from "../proposals/schema";
import { bookingEntry, booksSource, type SourceDocument } from "../sources";
import {
  documentsSchema,
  type Dismissal,
  type DocumentMediaType,
  type ProposedEntry,
} from "./schema";

type LedgerServices = ReturnType<typeof createLedgerFragment>["services"];
type ProposalsServices = ReturnType<typeof createProposalsFragment>["services"];
type PostEntryInput = Parameters<LedgerServices["postEntry"]>[0];
type ReverseEntryInput = Parameters<LedgerServices["reverseEntry"]>[0];

/** The ledger kind of the source documents that documents are. */
export const DOCUMENT_SOURCE_KIND = "document";

const PAGE_SIZE = 50;

const documentErrorMessages = {
  DOCUMENT_NOT_FOUND: "This document does not exist.",
  DOCUMENT_ID_TAKEN: "Another file was uploaded with this form. Upload it again.",
  DOCUMENT_BOOKED: "This document is booked. Reverse its entry first.",
  DOCUMENT_DISMISSED: "This document was dismissed.",
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

/** What the bookkeeping agent made of a document: it proposes entries. */
export type DocumentProposal = AgentProposal<ProposedEntry>;

export type DocumentView = NewDocument & {
  uploadedAt: Date;
  proposal: DocumentProposal | null;
  /** Whether its file may still be shared with a firm's bookkeeping agent. */
  shared: boolean;
  /** The ledger's source document, once an entry recorded it, with every entry recording it. */
  source: SourceDocument | null;
  state: DocumentState;
};

type DocumentRow = Omit<DocumentView, "proposal" | "source" | "state"> & {
  dismissal: Dismissal | null;
};

function documentState(dismissal: Dismissal | null, source: SourceDocument | null): DocumentState {
  if (dismissal !== null) {
    return { status: "dismissed", ...dismissal };
  }
  const inEffect = bookingEntry(source);
  return inEffect ? { status: "booked", entryId: inEffect.id } : { status: "to-book" };
}

/** The proposal for a document, of the proposals read for it. */
function proposalOf(
  proposals: { id: string; proposal: AgentProposal<unknown> }[],
): DocumentProposal | null {
  // Only answers about a document are recorded under its ID, and they propose entries.
  return (proposals[0]?.proposal as DocumentProposal | undefined) ?? null;
}

/** The request a document to book awaits an answer to, if any. */
function awaitedRequest(
  dismissal: Dismissal | null,
  source: SourceDocument | null,
  proposal: DocumentProposal | null,
): string | null {
  return proposal?.status === "requested" && documentState(dismissal, source).status === "to-book"
    ? proposal.requestId
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

/** The document a request or answer is about, refused unless it is to book. */
function subjectToBook<TDocument extends { dismissal: Dismissal | null }>(
  document: TDocument | null,
  source: SourceDocument | null,
): TDocument {
  if (!document) {
    throw new DocumentError("DOCUMENT_NOT_FOUND");
  }
  assertToBook(documentState(document.dismissal, source));
  return document;
}

/** A document with what the ledger records of it, and the bookkeeping agent's proposal. */
export function describeDocument(
  row: DocumentRow,
  source: SourceDocument | null,
  proposals: { id: string; proposal: AgentProposal<unknown> }[],
): DocumentView {
  const { dismissal, ...document } = row;
  return {
    ...document,
    proposal: proposalOf(proposals.filter((proposal) => proposal.id === row.id)),
    source,
    state: documentState(dismissal, source),
  };
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
    shared: document.shared,
  };
}

/**
 * Documents uploaded to an administration's books, booked through its ledger in the same
 * transaction, so a document is booked and dismissed by the rules of both. The agent proposes how
 * to book only documents to book.
 */
const documentsFragmentDefinition = defineFragment("documents")
  .extend(withDatabase(documentsSchema))
  .usesService<"ledger", LedgerServices>("ledger")
  .usesService<"proposals", ProposalsServices>("proposals")
  .providesBaseService(({ defineService, serviceDeps }) =>
    defineService({
      /**
       * Records an uploaded document; recording the same one again does nothing. Returns the key
       * of the file the document keeps, another upload's when that one recorded it first.
       */
      recordDocument: function (document: NewDocument) {
        return this.serviceTx(documentsSchema)
          .retrieve((uow) =>
            uow.findFirst("document", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", document.id)),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing] }): string => {
            if (existing) {
              if (existing.sha256 !== document.sha256) {
                throw new DocumentError("DOCUMENT_ID_TAKEN");
              }
              return existing.storageKey;
            }
            uow.create(
              "document",
              {
                ...document,
                uploadedAt: uow.now(),
                bookings: 0,
                dismissal: null,
                shared: false,
              },
              // A concurrent upload recorded it: retrying reads it and compares the files. Its ID is
              // the table's only unique key.
              { retryOnUniqueConflict: () => true },
            );
            return document.storageKey;
          })
          .build();
      },

      /** A page of documents, newest first, without the ledger's records of them, or proposals. */
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
          .withServiceCalls(
            () =>
              [
                serviceDeps.ledger.getSourceDocuments({ ids: [id] }),
                serviceDeps.proposals.getProposals({ ids: [id] }),
              ] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("document", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id))),
          )
          .transformRetrieve(([document], [sources, proposals]): DocumentView | null =>
            document ? describeDocument(toRow(document), sources[0] ?? null, proposals) : null,
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
            if (booksSource(entry, source)) {
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
       * Records that the bookkeeping agent was asked to propose how to book a document to book, as
       * the proposals fragment records requests, and that its file may be shared with it. Returns
       * the proposal in effect.
       */
      requestProposal: function (input: {
        documentId: string;
        request: ProposalRequest;
        first: boolean;
      }) {
        const { documentId, request, first } = input;
        return this.serviceTx(documentsSchema)
          .withServiceCalls(
            () =>
              [
                serviceDeps.ledger.getSourceDocuments({ ids: [documentId] }),
                serviceDeps.proposals.requestProposal({ subjectId: documentId, request, first }),
              ] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("document", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", documentId)),
            ),
          )
          .transformRetrieve(([document], [sources]) => subjectToBook(document, sources[0] ?? null))
          .mutate(
            ({ uow, retrieveResult: document, serviceIntermediateResult: [, { recorded }] }) => {
              if (recorded) {
                uow.update("document", document.id, (b) => b.set({ shared: true }).check());
              }
            },
          )
          .transform(({ serviceResult: [, proposal] }) => proposal as DocumentProposal)
          .build();
      },

      /** Records an answer to a request about a document, as the proposals fragment does. */
      answerRequest: function (input: {
        documentId: string;
        request: string | null;
        answer: ProposalAnswer<ProposedEntry>;
      }) {
        const { documentId, request, answer } = input;
        return this.serviceTx(documentsSchema)
          .withServiceCalls(
            () =>
              [
                serviceDeps.ledger.getSourceDocuments({ ids: [documentId] }),
                serviceDeps.proposals.answerRequest({ subjectId: documentId, request, answer }),
              ] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("document", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", documentId)),
            ),
          )
          .transformRetrieve(([document], [sources]) => subjectToBook(document, sources[0] ?? null))
          .transform(() => answer)
          .build();
      },

      /**
       * The IDs of the documents whose files may still be shared: every one whose file a request
       * shared and no revocation since recorded unshared.
       */
      listSharedDocuments: function () {
        return this.serviceTx(documentsSchema)
          .retrieve((uow) => uow.find("document", (b) => b.whereIndex("primary")))
          .transformRetrieve(([documents]) =>
            documents.filter(({ shared }) => shared).map(({ id }) => id.valueOf()),
          )
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
            () =>
              [
                serviceDeps.ledger.getSourceDocuments({ ids: [documentId] }),
                serviceDeps.proposals.getProposals({ ids: [documentId] }),
              ] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("document", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", documentId)),
            ),
          )
          .mutate(
            ({
              uow,
              retrieveResult: [document],
              serviceIntermediateResult: [sources, proposals],
            }) => {
              if (!document) {
                throw new DocumentError("DOCUMENT_NOT_FOUND");
              }
              const awaited = awaitedRequest(
                document.dismissal,
                sources[0] ?? null,
                proposalOf(proposals),
              );
              if (awaited === null) {
                uow.update("document", document.id, (b) => b.set({ shared: false }).check());
              }
              return awaited;
            },
          )
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
            () =>
              [
                serviceDeps.ledger.getSourceDocuments({ ids: [documentId] }),
                serviceDeps.proposals.getProposals({ ids: [documentId] }),
              ] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("document", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", documentId)),
            ),
          )
          .mutate(
            ({
              uow,
              retrieveResult: [document],
              serviceIntermediateResult: [sources, proposals],
            }) => {
              if (!document) {
                throw new DocumentError("DOCUMENT_NOT_FOUND");
              }
              uow.update("document", document.id, (b) => b.set({ shared: true }).check());
              const awaited = awaitedRequest(
                document.dismissal,
                sources[0] ?? null,
                proposalOf(proposals),
              );
              return awaited === requestId;
            },
          )
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
  services: { ledger: LedgerServices; proposals: ProposalsServices },
) {
  return instantiate(documentsFragmentDefinition)
    .withConfig({})
    .withOptions(options)
    .withServices(services)
    .build();
}
