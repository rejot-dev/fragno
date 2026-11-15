import { Field } from "@fragno-private/design-system/controls/field";
import { Input } from "@fragno-private/design-system/controls/input";
import { Select } from "@fragno-private/design-system/controls/select";
import { BackofficeSystemState } from "@fragno-private/design-system/feedback/system-state";
import { PageHeading } from "@fragno-private/design-system/layout/page-heading";
import {
  SurfaceCard,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/layout/surface-panel";
import { Link, redirect, useOutletContext } from "react-router";
import { z } from "zod";

import { formatIban, parseIban } from "../../workers/books/banking/iban";
import { AccountName } from "../books/amounts";
import { bankAccountPath, booksPath, formatDate, indexBooks } from "../books/books";
import {
  parseForm,
  requireBooks,
  requireBooksSubmission,
  type FormResult,
} from "../books/books.server";
import { FormDialog } from "../books/forms";
import type { BooksOutletContext } from "../books/layout";
import type { Route } from "./+types/accounts";
import { SignedAmount } from "./transactions";

export function meta() {
  return [{ title: "Bank accounts · Bookkeeping" }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { books } = await requireBooks(request, params);
  return { bankAccounts: await books.listBankAccounts() };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const INTENT = "add-bank-account";

const bankAccountSchema = z.object({
  intent: z.literal(INTENT),
  name: z.string().trim().min(1, "Name the bank account.").max(100, "Use at most 100 characters."),
  iban: z.string().transform((text, context) => {
    const iban = parseIban(text);
    if (iban === null) {
      context.addIssue("Enter the account's IBAN, like NL91 ABNA 0417 1643 00.");
      return z.NEVER;
    }
    return iban;
  }),
  code: z
    .string()
    .trim()
    .min(1, "Give the ledger account a code.")
    .max(20, "Use a code of at most 20 characters."),
  journalId: z.string().min(1, "Choose the journal to book its transactions in."),
});

/**
 * Adds a bank account with a ledger account of its own, which only its transactions post to; then
 * opens it, to import its statements.
 */
export async function action({ request, params }: Route.ActionArgs): Promise<FormResult> {
  const { books } = await requireBooksSubmission(request, params, "set-up");
  const parsed = await parseForm(request, bankAccountSchema);
  if ("refusal" in parsed) {
    return parsed.refusal;
  }
  const { name, iban, code, journalId } = parsed.data;
  const outcome = await books.addBankAccount({ name, iban, ledgerAccountCode: code, journalId });
  if (!outcome.ok) {
    return { intent: INTENT, error: outcome.message };
  }
  throw redirect(bankAccountPath(booksPath(params), outcome.value.id));
}

const COLUMNS = [
  { label: "Bank account", align: "start" },
  { label: "Ledger account", align: "start" },
  { label: "Statements until", align: "start" },
  { label: "Balance", align: "end" },
] as const;

/** The first free four-digit code from 1000, where bank accounts sort among the assets. */
function freeBankCode(accounts: readonly { code: string }[]): string {
  const taken = new Set(accounts.map((account) => account.code));
  let code = 1000;
  while (taken.has(String(code))) {
    code += 1;
  }
  return String(code);
}

export default function BankAccountsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { books, base, canSetUp } = useOutletContext<BooksOutletContext>();
  const { bankAccounts } = loaderData;
  const index = indexBooks(books);
  const accountsByCode = new Map(books.accounts.map((account) => [account.code, account]));
  return (
    <>
      <PageHeading
        eyebrow={books.name}
        title="Bank accounts"
        meta={null}
        actions={
          canSetUp ? (
            <FormDialog
              label="Add bank account"
              variant="solid"
              title="Add bank account"
              description="It books to a ledger account of its own, which only its bank transactions post to."
              intent={INTENT}
              resultIntent={INTENT}
              submit="Add bank account"
              result={actionData}
            >
              <Field label="Name">
                <Input className="w-full" name="name" placeholder="Current account" required />
              </Field>
              <Field label="IBAN">
                <Input className="w-full" name="iban" required />
              </Field>
              <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
                <Field label="Account code">
                  <Input
                    className="w-full"
                    name="code"
                    defaultValue={freeBankCode(books.accounts)}
                    required
                  />
                </Field>
                <Field label="Journal">
                  <Select
                    name="journalId"
                    options={books.journals.map((journal) => ({
                      label: `${journal.code} · ${journal.name}`,
                      value: journal.id,
                    }))}
                    defaultValue={
                      books.journals.find((journal) => journal.code === "BNK")?.id ??
                      books.journals[0]?.id ??
                      null
                    }
                    required
                  />
                </Field>
              </div>
            </FormDialog>
          ) : null
        }
      />
      <SurfaceCard>
        {bankAccounts.length === 0 ? (
          <BackofficeSystemState
            flush
            tone="empty"
            label="Bank accounts"
            title="No bank accounts yet"
            description={
              canSetUp
                ? "Add the administration's bank accounts to import their statements and book their transactions."
                : "Owners and admins add the administration's bank accounts."
            }
          />
        ) : (
          <SurfaceTable columns={COLUMNS}>
            {bankAccounts.map((account) => {
              // A bank account's ledger account is created with it.
              const ledgerAccount = accountsByCode.get(account.ledgerAccountCode)!;
              return (
                <SurfaceTableRow
                  key={account.id}
                  columns={COLUMNS}
                  cells={[
                    <Link
                      key="name"
                      to={bankAccountPath(base, account.id)}
                      className="hover:underline"
                    >
                      <span className="font-medium text-[var(--bo-fg)]">{account.name}</span>
                      <span className="ml-2 text-[var(--bo-muted-2)] tabular-nums">
                        {formatIban(account.iban)}
                      </span>
                    </Link>,
                    <Link
                      key="ledger"
                      to={`${base}/accounts/${ledgerAccount.id}`}
                      className="hover:underline"
                    >
                      <AccountName account={ledgerAccount} />
                    </Link>,
                    account.lastStatement === null
                      ? "No statements yet"
                      : formatDate(account.lastStatement.endDate),
                    account.lastStatement === null ? (
                      ""
                    ) : (
                      <SignedAmount
                        key="balance"
                        minor={account.lastStatement.closingBalanceMinor}
                        digits={index.minorUnitDigits(account.currency)}
                      />
                    ),
                  ]}
                />
              );
            })}
          </SurfaceTable>
        )}
      </SurfaceCard>
    </>
  );
}
