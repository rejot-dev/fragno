import { column, idColumn, referenceColumn, schema, type Column } from "@fragno-dev/db/schema";

import type { ProposedLine } from "../proposals/schema";
import type { TransactionDetail } from "./detail";

/**
 * Where the last imported statement of a bank account left it: its end, and its closing balance
 * in minor units as a string of digits, as JSON holds no bigints.
 */
export type StatementEnd = { endDate: string; closingBalanceMinor: string };

/**
 * How the bookkeeping agent proposes to book a bank transaction, naming the books' records by ID,
 * with amounts as decimals: as a payment by or to a customer or supplier, settling their open
 * items; or with an entry's lines besides the bank account's, which the books add when booking.
 */
export type TransactionBooking =
  | {
      type: "payment";
      partyAccountId: string;
      settles: { openItemId: string; amount: string }[];
    }
  | {
      type: "entry";
      journalId: string;
      reference: string | null;
      description: string;
      lines: ProposedLine[];
    };

function jsonColumn<T>() {
  return column("json") as unknown as Column<"json", T, T>;
}

/**
 * The administration's bank accounts and what their banks' statements say moved on them. Each
 * account books to a ledger account of its own that takes only entries booking its transactions,
 * so its balance in the ledger is the bank's once every transaction is booked. Statements and
 * their transactions are the bank's facts, imported once and never changed.
 */
export const bankingSchema = schema("banking", (s) => {
  return (
    s
      .addTable("bankAccount", (t) => {
        return (
          t
            .addColumn("id", idColumn())
            .addColumn("iban", column("string"))
            .addColumn("name", column("string"))
            .addColumn("currency", column("string"))
            // The ledger account it books to, by code: created with it, and codes never change.
            .addColumn("ledgerAccountCode", column("string"))
            // The ledger journal its transactions are booked in, by ID.
            .addColumn("journalId", column("string"))
            // Null until its first statement is imported. Each import updates it with a version
            // check, so two imports of the account cannot both continue the same statement.
            .addColumn("lastStatement", jsonColumn<StatementEnd | null>().nullable())
            .createIndex("idx_bank_account_iban", ["iban"], { unique: true })
        );
      })
      .addTable("statement", (t) => {
        return (
          t
            .addColumn("id", idColumn())
            .addColumn("bankAccountId", referenceColumn({ table: "bankAccount" }))
            // The bank's ID for the statement: importing it again skips it.
            .addColumn("reference", column("string"))
            // A hash of the statement as read, so the same ID saying something else is refused
            // rather than skipped.
            .addColumn("fingerprint", column("string"))
            .addColumn("startDate", column("string"))
            .addColumn("endDate", column("string"))
            .addColumn("openingBalanceMinor", column("bigint"))
            .addColumn("closingBalanceMinor", column("bigint"))
            .addColumn("importedAt", column("timestamp"))
            .addColumn("importedBy", column("string"))
            .createIndex("idx_statement_reference", ["bankAccountId", "reference"], {
              unique: true,
            })
            .createIndex("idx_statement_end", ["bankAccountId", "endDate"])
        );
      })
      .addTable("transaction", (t) => {
        return (
          t
            // Also the ID of the ledger source document its entries record.
            .addColumn("id", idColumn())
            .addColumn("bankAccountId", referenceColumn({ table: "bankAccount" }))
            .addColumn("statementId", referenceColumn({ table: "statement" }))
            .addColumn("bookingDate", column("string"))
            // Positive when money came in.
            .addColumn("amountMinor", column("bigint"))
            .addColumn("detail", jsonColumn<TransactionDetail>())
            // Whether an entry books it now, as the ledger's entries recording it say. Kept with
            // them in each booking's and reversal's transaction, so transactions to book list by
            // index.
            .addColumn("booked", column("bool"))
            .createIndex("idx_transaction_account_date", ["bankAccountId", "bookingDate"])
            .createIndex("idx_transaction_account_booked_date", [
              "bankAccountId",
              "booked",
              "bookingDate",
            ])
        );
      })
      // The customers and suppliers an IBAN paid or was paid by, learned as transactions are booked.
      .addTable("counterparty", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("iban", column("string"))
          .addColumn("partyAccountId", column("string"))
          .createIndex("idx_counterparty_iban", ["iban", "partyAccountId"], { unique: true })
          .createIndex("idx_counterparty_party", ["partyAccountId", "iban"], { unique: true });
      })
  );
});
