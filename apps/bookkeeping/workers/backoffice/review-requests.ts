/**
 * How every request asking the bookkeeping agent about a document begins. The firm's agent answers
 * every administration of its clients, where a document's ID is unique only in its own.
 */
export function documentRequestPrefix(administrationId: string, documentId: string): string {
  return `document:${administrationId}:${documentId}:`;
}
