import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

/** The kinds of file a document can be: what people scan and photograph, never markup. */
export const DOCUMENT_MEDIA_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export type DocumentMediaType = (typeof DOCUMENT_MEDIA_TYPES)[number];

/** Who dismissed a document and when, as an ISO timestamp. */
export type Dismissal = { by: string; at: string };

function stringColumn<T extends string>() {
  return column("string") as unknown as Column<"string", T, T>;
}

function jsonColumn<T>() {
  return column("json") as unknown as Column<"json", T, T>;
}

/**
 * The documents uploaded to an administration's books, such as invoices and receipts. The bytes
 * live elsewhere, under `storageKey`, which only the application interprets; `sha256` tells when
 * they changed there. Whether a document is booked is the ledger's: its ID is the ID of the source
 * document its entries record.
 */
export const documentsSchema = schema("documents", (s) => {
  return s.addTable("document", (t) => {
    return (
      t
        .addColumn("id", idColumn())
        .addColumn("filename", column("string"))
        .addColumn("mediaType", stringColumn<DocumentMediaType>())
        .addColumn("sizeBytes", column("integer"))
        .addColumn("sha256", column("string"))
        .addColumn("storageKey", column("string"))
        .addColumn("uploadedAt", column("timestamp"))
        .addColumn("uploadedBy", column("string"))
        // Claimed by each booking, reversing a reversal included, as entries claim their journal's
        // numbers, so two bookings of a document at once conflict instead of both posting.
        .addColumn("bookings", column("integer"))
        .addColumn("dismissal", jsonColumn<Dismissal | null>().nullable())
        .createIndex("idx_document_uploaded", ["uploadedAt"])
    );
  });
});
