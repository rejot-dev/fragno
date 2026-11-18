import { Button, ButtonLink } from "@fragno-private/design-system/controls/button";
import { Field } from "@fragno-private/design-system/controls/field";
import { FileInput } from "@fragno-private/design-system/controls/file-input";
import { BackofficeSystemState } from "@fragno-private/design-system/feedback/system-state";
import { PageHeading } from "@fragno-private/design-system/layout/page-heading";
import {
  SurfaceCard,
  SurfaceFacts,
  SurfacePanelBody,
  SurfacePanelFooter,
  SurfaceSection,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/layout/surface-panel";
import { Form, Link, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import type { ImportResult } from "../../workers/books/banking/banking";
import { parseCamt053 } from "../../workers/books/banking/camt053";
import { describeTransaction } from "../../workers/books/banking/detail";
import { formatIban } from "../../workers/books/banking/iban";
import { AccountName } from "../books/amounts";
import { askBookkeeper } from "../books/bookkeeper.server";
import { bankAccountPath, formatDate, indexBooks, transactionPath } from "../books/books";
import { requireBooks, requireBooksSubmission } from "../books/books.server";
import { FormError } from "../books/forms";
import type { BooksOutletContext } from "../books/layout";
import { DOCUMENT_MAX_SIZE, readUploadForm } from "../documents/documents.server";
import type { Route } from "./+types/account";
import { settlesWhole, suggestPayments } from "./matching.server";
import { SignedAmount, TransactionStatus } from "./transactions";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.bankAccount.name ?? "Bank account"} · Bookkeeping` }];
}

type Context = Awaited<ReturnType<typeof requireBooks>>;

/** Which of the account's transactions the page lists: those to book, or all of them. */
const SHOWS = ["to-book", "all"] as const;

async function requireBankAccount(context: Context, bankAccountId: string) {
  const bankAccount = await context.books.getBankAccount(bankAccountId);
  if (!bankAccount) {
    throw new Response("This bank account does not exist.", { status: 404 });
  }
  return bankAccount;
}

/** The bank account and a page of its transactions, latest first. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await requireBooks(request, params);
  const bankAccount = await requireBankAccount(context, params.bankAccountId);
  const url = new URL(request.url);
  const show = url.searchParams.get("show") === "all" ? "all" : "to-book";
  const cursor = url.searchParams.get("cursor");
  return {
    bankAccount,
    show,
    paged: cursor !== null,
    transactions: await context.books.listTransactions({
      bankAccountId: bankAccount.id,
      toBook: show === "to-book",
      cursor,
    }),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const IMPORT = "import";

const importSchema = z.object({
  intent: z.literal(IMPORT),
  file: z.instanceof(File, { error: "Choose a statement file to import." }),
});

/** How many imported transactions the bookkeeping agent was asked about, or why it was not. */
type Asked = { ok: true; count: number } | { ok: false; error: string };

type ImportAnswer =
  | { intent: string; error: string; imported: null; asked: null }
  | { intent: string; error: null; imported: ImportResult; asked: Asked };

/**
 * Asks the bookkeeping agent how to book the imported transactions that the payment form, as it
 * starts, does not book whole as settling what they pay. Opening balances are left to people: they
 * are what the books held before, which the bank does not say.
 */
async function askAboutImported(context: Context, transactionIds: string[]): Promise<Asked> {
  const [books, imported] = await Promise.all([
    context.books.describe(),
    context.books.getTransactions(transactionIds),
  ]);
  // Asked in the order they were imported, as the bank listed them.
  const position = new Map(transactionIds.map((id, index) => [id, index]));
  const transactions = imported
    .filter((transaction) => transaction.detail.type !== "opening-balance")
    .sort((a, b) => position.get(a.id)! - position.get(b.id)!);
  const suggestions = await suggestPayments(
    context,
    books,
    transactions.map((transaction) => ({ transaction, chosen: null })),
  );
  const subjects = transactions
    .filter((transaction, index) => !settlesWhole(transaction, suggestions[index]))
    .map((transaction) => ({
      kind: "transaction" as const,
      transaction: {
        id: transaction.id,
        description: describeTransaction(transaction.detail),
      },
    }));
  const asked = await askBookkeeper(context, subjects, "first");
  return asked.ok ? { ok: true, count: subjects.length } : asked;
}

/**
 * Imports the statements of a CAMT.053 file, continuing the last one imported, and asks the
 * bookkeeping agent about the new transactions people cannot book as they are suggested. Importing
 * a file again imports only the statements it has that were not imported before.
 */
export async function action({ request, params }: Route.ActionArgs): Promise<ImportAnswer> {
  const context = await requireBooksSubmission(request, params, "keep");
  const bankAccount = await requireBankAccount(context, params.bankAccountId);
  const refuse = (error: string) => ({ intent: IMPORT, error, imported: null, asked: null });
  const form = await readUploadForm(request);
  if (form === null) {
    return refuse(`Import files of at most ${DOCUMENT_MAX_SIZE}.`);
  }
  const parsedForm = importSchema.safeParse(Object.fromEntries(form));
  if (!parsedForm.success) {
    return refuse(parsedForm.error.issues[0]?.message ?? "Check the form.");
  }
  const { currencies } = await context.books.describe();
  const parsed = parseCamt053(
    await parsedForm.data.file.text(),
    (currency) => currencies.find((row) => row.code === currency)?.minorUnitDigits ?? null,
  );
  if (!parsed.ok) {
    return refuse(parsed.error);
  }
  const outcome = await context.books.importStatements({
    bankAccountId: bankAccount.id,
    statements: parsed.statements,
    importedBy: context.user.name,
  });
  if (!outcome.ok) {
    return refuse(outcome.message);
  }
  return {
    intent: IMPORT,
    error: null,
    imported: outcome.value,
    asked: await askAboutImported(context, outcome.value.transactionIds),
  };
}

const COLUMNS = [
  { label: "Date", align: "start" },
  { label: "Transaction", align: "start" },
  { label: "Amount", align: "end" },
  { label: "Status", align: "start" },
] as const;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export default function BankAccountPage({ loaderData, actionData }: Route.ComponentProps) {
  const context = useOutletContext<BooksOutletContext>();
  const { books, base } = context;
  const navigation = useNavigation();
  const { bankAccount, transactions, show, paged } = loaderData;
  const digits = indexBooks(books).minorUnitDigits(bankAccount.currency);
  // A bank account's ledger account is created with it.
  const ledgerAccount = books.accounts.find(
    (account) => account.code === bankAccount.ledgerAccountCode,
  )!;
  const accountPath = bankAccountPath(base, bankAccount.id);
  const answer = actionData?.intent === IMPORT && actionData.error === null ? actionData : null;
  return (
    <>
      <PageHeading
        eyebrow={
          <Link to={`${base}/bank`} className="hover:underline">
            Bank accounts
          </Link>
        }
        title={bankAccount.name}
        meta={formatIban(bankAccount.iban)}
        actions={null}
      />
      <SurfaceCard>
        <SurfaceFacts
          items={[
            {
              key: "ledger",
              label: "Books to",
              value: (
                <Link to={`${base}/accounts/${ledgerAccount.id}`} className="hover:underline">
                  <AccountName account={ledgerAccount} />
                </Link>
              ),
            },
            {
              key: "statements",
              label: "Statements until",
              value:
                bankAccount.lastStatement === null
                  ? "None imported yet"
                  : formatDate(bankAccount.lastStatement.endDate),
            },
            {
              key: "balance",
              label: "Bank balance",
              value:
                bankAccount.lastStatement === null ? (
                  "Unknown"
                ) : (
                  <SignedAmount
                    minor={bankAccount.lastStatement.closingBalanceMinor}
                    digits={digits}
                  />
                ),
            },
          ]}
        />
      </SurfaceCard>
      <SurfaceCard>
        <Form method="post" encType="multipart/form-data">
          <SurfacePanelBody>
            <input type="hidden" name="intent" value={IMPORT} />
            <div className="flex flex-wrap items-end gap-3">
              <Field
                label="Import statements"
                description="A CAMT.053 file, as your bank exports it. Statements imported before are skipped."
                className="min-w-64 flex-1"
              >
                <FileInput name="file" accept=".xml,.053,application/xml,text/xml" required />
              </Field>
              <Button type="submit" variant="solid" disabled={navigation.state !== "idle"}>
                Import
              </Button>
            </div>
            <FormError result={actionData} intent={IMPORT} />
            {answer === null ? null : (
              <p role="status" className="text-sm text-pretty text-[var(--bo-muted)]">
                {answer.imported.imported === 0
                  ? "Nothing new: every statement in the file was imported before."
                  : `Imported ${plural(answer.imported.imported, "statement", "statements")} with ${plural(answer.imported.transactionIds.length, "transaction", "transactions")} to book.`}
                {answer.imported.imported > 0 && answer.imported.skipped > 0
                  ? ` ${plural(answer.imported.skipped, "statement was", "statements were")} imported before.`
                  : ""}
                {!answer.asked.ok
                  ? ` The bookkeeping agent was not asked about them: ${answer.asked.error}`
                  : answer.asked.count > 0
                    ? ` Asked the bookkeeping agent how to book ${answer.asked.count} of them.`
                    : ""}
              </p>
            )}
          </SurfacePanelBody>
        </Form>
      </SurfaceCard>
      <SurfaceSection
        title={show === "to-book" ? "To book" : "All transactions"}
        meta={null}
        actions={
          <div className="flex gap-1">
            {SHOWS.map((option) => (
              <ButtonLink
                key={option}
                variant={option === show ? "secondary" : "ghost"}
                to={option === "to-book" ? accountPath : `${accountPath}?show=all`}
              >
                {option === "to-book" ? "To book" : "All"}
              </ButtonLink>
            ))}
          </div>
        }
      >
        {transactions.items.length === 0 ? (
          <BackofficeSystemState
            flush
            tone="empty"
            label="Transactions"
            title={
              bankAccount.lastStatement === null
                ? "No transactions yet"
                : show === "to-book"
                  ? "Nothing to book"
                  : "No transactions"
            }
            description={
              bankAccount.lastStatement === null
                ? "Import the account's statements to book their transactions."
                : show === "to-book"
                  ? "Every imported transaction is booked. Import the next statements to book theirs."
                  : "The imported statements have no transactions."
            }
          />
        ) : (
          <SurfaceTable columns={COLUMNS}>
            {transactions.items.map((transaction) => (
              <SurfaceTableRow
                key={transaction.id}
                columns={COLUMNS}
                cells={[
                  <span key="date" className="whitespace-nowrap tabular-nums">
                    {formatDate(transaction.bookingDate)}
                  </span>,
                  <Link
                    key="transaction"
                    to={transactionPath(base, transaction.id)}
                    className="font-medium text-[var(--bo-fg)] hover:underline"
                  >
                    {describeTransaction(transaction.detail)}
                  </Link>,
                  <SignedAmount key="amount" minor={transaction.amountMinor} digits={digits} />,
                  <TransactionStatus key="status" transaction={transaction} context={context} />,
                ]}
              />
            ))}
          </SurfaceTable>
        )}
        {transactions.cursor !== null || paged ? (
          <SurfacePanelFooter>
            {paged ? (
              <ButtonLink
                variant="ghost"
                to={show === "all" ? `${accountPath}?show=all` : accountPath}
              >
                Latest transactions
              </ButtonLink>
            ) : null}
            {transactions.cursor !== null ? (
              <ButtonLink
                variant="secondary"
                to={`${accountPath}?${show === "all" ? "show=all&" : ""}cursor=${transactions.cursor}`}
              >
                Earlier transactions
              </ButtonLink>
            ) : null}
          </SurfacePanelFooter>
        ) : null}
      </SurfaceSection>
    </>
  );
}
