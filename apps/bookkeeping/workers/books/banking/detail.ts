import type { TransactionPart } from "./camt053";

/** What bank transactions are and say, as pages show them too: no server code. */

/**
 * What a bank transaction is: an entry of a statement, or the balance the account's first imported
 * statement opened with, booked once like any transaction.
 */
export type TransactionDetail =
  | { type: "opening-balance" }
  | {
      type: "entry";
      /** The bank's reference for the entry. */
      bankReference: string;
      valueDate: string;
      information: string;
      parts: TransactionPart[];
    };

/**
 * What a transaction was, as one line: who paid or was paid and what for, else what the bank says
 * of it.
 */
export function describeTransaction(detail: TransactionDetail): string {
  if (detail.type === "opening-balance") {
    return "Opening balance";
  }
  const names = [...new Set(detail.parts.flatMap((part) => part.name ?? []))].join(", ");
  const remittance = detail.parts.map((part) => part.remittance).filter((text) => text !== "");
  const what = remittance.length > 0 ? remittance.join("; ") : detail.information;
  return [names, what].filter((text) => text !== "").join(": ") || "Bank transaction";
}
