import bankAccounts from "./banking/bank-accounts.sql?raw";
import bankReconciliation from "./banking/reconciliation.sql?raw";
import bankStatements from "./banking/statements.sql?raw";
import budgets from "./budgeting/budgets.sql?raw";
import classification from "./classification/classification.sql?raw";
import invoices from "./invoicing/invoices.sql?raw";
import paymentTerms from "./invoicing/payment-terms.sql?raw";
import accounts from "./ledger/accounts.sql?raw";
import calendar from "./ledger/calendar.sql?raw";
import dimensions from "./ledger/dimensions.sql?raw";
import journal from "./ledger/journal.sql?raw";
import parties from "./ledger/parties.sql?raw";
import settlement from "./ledger/settlement.sql?raw";
import sources from "./ledger/sources.sql?raw";
import vatCodes from "./vat/codes.sql?raw";
import vatInvoices from "./vat/invoice-vat.sql?raw";
import vatLineFacts from "./vat/line-facts.sql?raw";
import vatReturns from "./vat/returns.sql?raw";

// Files only reference what comes before them: the ledger first, then the areas built on it.
// Seed rows (source kinds) need their table to exist; foreign keys and trigger bodies are
// resolved only when rows are written.
export const bookkeepingSchema = [
  calendar,
  accounts,
  dimensions,
  parties,
  sources,
  journal,
  settlement,
  classification,
  paymentTerms,
  invoices,
  bankAccounts,
  bankStatements,
  bankReconciliation,
  budgets,
  vatCodes,
  vatLineFacts,
  vatInvoices,
  vatReturns,
].join("\n");
