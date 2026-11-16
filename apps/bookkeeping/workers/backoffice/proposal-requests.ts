/** What the bookkeeping agent is asked about: a document, or a bank transaction, by ID. */
export type ProposalSubject = { kind: "document" | "transaction"; id: string };

/**
 * How every request asking the bookkeeping agent about `subject` begins. The firm's agent answers
 * every administration of its clients, where a subject's ID is unique only in its own.
 */
export function requestPrefix(administrationId: string, subject: ProposalSubject): string {
  return `${subject.kind}:${administrationId}:${subject.id}:`;
}

/** The subject a request is about: its ID as `requestPrefix` begins it, without the last colon. */
export function requestSubject(requestId: string): string {
  return requestId.slice(0, requestId.lastIndexOf(":"));
}
