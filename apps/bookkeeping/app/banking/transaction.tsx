import { Button, ButtonLink } from "@fragno-private/design-system/controls/button";
import { Input } from "@fragno-private/design-system/controls/input";
import { Select } from "@fragno-private/design-system/controls/select";
import { BackofficeStatusLight } from "@fragno-private/design-system/feedback/status-light";
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
import { Form, Link, redirect, useNavigation, useOutletContext } from "react-router";

import type { TransactionView } from "../../workers/books/banking/banking";
import { describeTransaction } from "../../workers/books/banking/detail";
import { formatIban } from "../../workers/books/banking/iban";
import type { Books } from "../../workers/books/books";
import { decimalAmount, formatAmount, parseAmount } from "../../workers/books/money";
import {
  bankAccountPath,
  booksPath,
  entryPath,
  formatDate,
  indexBooks,
  transactionPath,
} from "../books/books";
import { requireBooks, requireBooksSubmission, type FormResult } from "../books/books.server";
import { FormError } from "../books/forms";
import type { BooksOutletContext } from "../books/layout";
import type { Route } from "./+types/transaction";
import { SignedAmount, transactionEntries, TransactionStatus } from "./transactions";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: `${loaderData ? describeTransaction(loaderData.transaction.detail) : "Bank transaction"} · Bookkeeping`,
    },
  ];
}

type Context = Awaited<ReturnType<typeof requireBooks>>;
type Described = Awaited<ReturnType<Books["describe"]>>;
type OpenItem = Awaited<ReturnType<Books["listOpenItems"]>>[number];

async function requireTransaction(context: Context, transactionId: string) {
  const transaction = await context.books.getTransaction(transactionId);
  if (!transaction) {
    throw new Response("This bank transaction does not exist.", { status: 404 });
  }
  return transaction;
}

/** A name as compared with another: lowercase letters and digits, without legal forms. */
function comparable(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(b\.?v\.?|n\.?v\.?|v\.?o\.?f\.?|ltd|inc|gmbh|llc)\b/gu, "")
    .replace(/[^a-z0-9]/gu, "");
}

/**
 * The customers and suppliers the transaction is likely with: those its counterparty's IBAN paid
 * or was paid by before, then those named like it. Customers come first for money in, suppliers
 * for money out.
 */
function suggestPartyAccounts(
  transaction: TransactionView,
  books: Described,
  learned: readonly string[],
): string[] {
  const names =
    transaction.detail.type === "entry"
      ? transaction.detail.parts.flatMap((part) =>
          part.name === null ? [] : comparable(part.name),
        )
      : [];
  const named = books.parties.filter((party) => {
    const name = comparable(party.name);
    return (
      name.length >= 3 &&
      names.some(
        (candidate) =>
          candidate.length >= 3 && (candidate.includes(name) || name.includes(candidate)),
      )
    );
  });
  const role = transaction.amountMinor > 0n ? "customer" : "supplier";
  const byRole = named
    .flatMap((party) => party.accounts)
    .sort((a, b) => Number(b.role === role) - Number(a.role === role))
    .map((account) => account.id);
  const exists = new Set(books.parties.flatMap((party) => party.accounts.map(({ id }) => id)));
  return [...new Set([...learned.filter((id) => exists.has(id)), ...byRole])];
}

/**
 * Whether `text` names `reference` whole: not as part of a longer one, as `INV-10` holds `INV-1`.
 * Case and runs of spaces do not count.
 */
function names(text: string, reference: string): boolean {
  const said = text.toUpperCase().replace(/\s+/gu, " ");
  const wanted = reference.toUpperCase().replace(/\s+/gu, " ").trim();
  const alphanumeric = (character: string | undefined) =>
    character !== undefined && /[\p{L}\p{N}]/u.test(character);
  for (let at = said.indexOf(wanted); at !== -1; at = said.indexOf(wanted, at + 1)) {
    if (!alphanumeric(said[at - 1]) && !alphanumeric(said[at + wanted.length])) {
      return wanted !== "";
    }
  }
  return false;
}

/** The side of the open items a payment settles: invoices for money in, bills for money out. */
function settledSide(transaction: { amountMinor: bigint }): "debit" | "credit" {
  return transaction.amountMinor > 0n ? "debit" : "credit";
}

/**
 * The open items the transaction settles to start with, with how much of each: those whose
 * reference its description names, else the first owing exactly its amount; each for what it has
 * outstanding, within the transaction's amount.
 */
function preselect(transaction: TransactionView, items: OpenItem[]): Map<string, bigint> {
  const { detail } = transaction;
  const said =
    detail.type === "entry"
      ? [...detail.parts.map((part) => part.remittance), detail.information].join(" ")
      : "";
  const amount = transaction.amountMinor > 0n ? transaction.amountMinor : -transaction.amountMinor;
  const named = items.filter(
    (item) => item.entry.reference !== null && names(said, item.entry.reference),
  );
  const exact = items.find((item) => item.outstandingMinor === amount);
  const chosen = named.length > 0 ? named : exact ? [exact] : [];
  const amounts = new Map<string, bigint>();
  let left = amount;
  for (const item of chosen) {
    const settled = item.outstandingMinor < left ? item.outstandingMinor : left;
    if (settled > 0n) {
      amounts.set(item.id, settled);
      left -= settled;
    }
  }
  return amounts;
}

/** The open items of `partyAccountId` the transaction can settle: in its currency, on the other side. */
async function settleableItems(
  context: Context,
  transaction: TransactionView,
  partyAccountId: string,
) {
  const items = await context.books.listOpenItems({ partyAccountId });
  return items.filter(
    (item) =>
      item.outstandingMinor > 0n &&
      item.side === settledSide(transaction) &&
      item.currency === transaction.bankAccount.currency,
  );
}

/**
 * The transaction, and while it is to book, the customers and suppliers it is likely with and the
 * open items of the one chosen, `?party=` or the likeliest, it can settle.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await requireBooks(request, params);
  const transaction = await requireTransaction(context, params.transactionId);
  if (transaction.state.status !== "to-book") {
    return { transaction, suggested: [], partyAccountId: null, items: [], preselected: {} };
  }
  const { detail } = transaction;
  const ibans =
    detail.type === "entry" ? [...new Set(detail.parts.flatMap((part) => part.iban ?? []))] : [];
  const [books, learned] = await Promise.all([
    context.books.describe(),
    ibans.length === 1 ? context.books.counterpartiesOf(ibans[0]) : [],
  ]);
  const suggested = suggestPartyAccounts(transaction, books, learned);
  const partyAccounts = new Set(
    books.parties.flatMap((party) => party.accounts.map(({ id }) => id)),
  );
  const asked = new URL(request.url).searchParams.get("party");
  const partyAccountId =
    asked !== null && partyAccounts.has(asked) ? asked : (suggested[0] ?? null);
  const items =
    partyAccountId === null ? [] : await settleableItems(context, transaction, partyAccountId);
  return {
    transaction,
    suggested,
    partyAccountId,
    items,
    preselected: Object.fromEntries(preselect(transaction, items)),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const SETTLE = "settle";

/**
 * Books the transaction as a payment by or to a customer or supplier, settling the open items
 * chosen for the amounts given; what it paid beyond them stays open on their account.
 */
export async function action({ request, params }: Route.ActionArgs): Promise<FormResult> {
  const context = await requireBooksSubmission(request, params, "keep");
  const transaction = await requireTransaction(context, params.transactionId);
  const form = await request.formData();
  const refuse = (error: string) => ({ intent: SETTLE, error });
  const partyAccountId = form.get("partyAccountId");
  const books = await context.books.describe();
  const partyAccount = books.parties
    .flatMap((party) => party.accounts)
    .find((account) => account.id === partyAccountId);
  if (!partyAccount) {
    return refuse("Choose the customer or supplier the payment is with.");
  }
  const { bankAccount } = transaction;
  const digits = books.currencies.find((row) => row.code === bankAccount.currency)!.minorUnitDigits;
  const items = await settleableItems(context, transaction, partyAccount.id);
  const settles = [];
  for (const itemId of form.getAll("settle")) {
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item) {
      return refuse("Choose open items this payment can settle.");
    }
    const amountMinor = parseAmount(String(form.get(`amount.${item.id}`) ?? ""), digits);
    if (amountMinor === null || amountMinor === 0n) {
      return refuse(
        `Enter the amount to settle as a number with at most ${digits} decimals, like 1234.50.`,
      );
    }
    settles.push({ openItemId: item.id, amountMinor });
  }
  const amountMinor =
    transaction.amountMinor > 0n ? transaction.amountMinor : -transaction.amountMinor;
  const outcome = await context.books.bookTransaction({
    transactionId: transaction.id,
    journalId: bankAccount.journalId,
    description: describeTransaction(transaction.detail).slice(0, 500),
    reference: null,
    postedBy: context.user.name,
    lines: [
      {
        accountId: partyAccount.controlAccountId,
        side: transaction.amountMinor > 0n ? "credit" : "debit",
        currency: bankAccount.currency,
        amountMinor,
        functionalAmountMinor: amountMinor,
        description: "",
        dimensionValueIds: [],
        openItem: { partyAccountId: partyAccount.id, dueDate: transaction.bookingDate, settles },
      },
    ],
  });
  if (!outcome.ok) {
    return refuse(outcome.message);
  }
  throw redirect(transactionPath(booksPath(params), transaction.id));
}

const ENTRY_COLUMNS = [
  { label: "Entry", align: "start" },
  { label: "Date", align: "start" },
  { label: "", align: "end" },
] as const;

const PART_COLUMNS = [
  { label: "Counterparty", align: "start" },
  { label: "IBAN", align: "start" },
  { label: "Description", align: "start" },
] as const;

const ITEM_COLUMNS = [
  { label: "Settle", align: "start" },
  { label: "Entry", align: "start" },
  { label: "Description", align: "start" },
  { label: "Due", align: "start" },
  { label: "Outstanding", align: "end" },
  { label: "Amount", align: "end" },
] as const;

export default function TransactionPage({ loaderData, actionData }: Route.ComponentProps) {
  const context = useOutletContext<BooksOutletContext>();
  const { books, base } = context;
  const navigation = useNavigation();
  const { transaction, suggested, partyAccountId, items, preselected } = loaderData;
  const { detail, bankAccount, state } = transaction;
  const index = indexBooks(books);
  const digits = index.minorUnitDigits(bankAccount.currency);
  const entries = transactionEntries(transaction.source, context);
  const entryNames = new Map(entries.map((entry) => [entry.id, entry.name]));
  const parts = detail.type === "entry" ? detail.parts : [];
  const counterparties = [...new Set(parts.flatMap((part) => part.name ?? []))];
  const ibans = [...new Set(parts.flatMap((part) => part.iban ?? []))];
  const remittance = parts.map((part) => part.remittance).filter((text) => text !== "");
  const suggestedIds = new Set(suggested);
  const partyAccountOptions = [...index.partyAccounts.values()]
    .sort((a, b) => Number(suggestedIds.has(b.id)) - Number(suggestedIds.has(a.id)))
    .map((account) => ({
      label: `${account.code} · ${account.party.name} (${account.role}${suggestedIds.has(account.id) ? ", suggested" : ""})`,
      value: account.id,
    }));
  const journalCode = (item: (typeof items)[number]) =>
    index.journals.get(item.entry.journalId)!.code;
  return (
    <>
      <PageHeading
        eyebrow={
          <Link to={bankAccountPath(base, bankAccount.id)} className="hover:underline">
            {bankAccount.name}
          </Link>
        }
        title={describeTransaction(detail)}
        meta={formatDate(transaction.bookingDate)}
        actions={
          state.status === "to-book" ? (
            <ButtonLink
              variant="secondary"
              to={`${base}/entries/new?transaction=${transaction.id}`}
            >
              Book with an entry
            </ButtonLink>
          ) : null
        }
      />
      <SurfaceCard>
        <SurfaceFacts
          items={[
            {
              key: "status",
              label: "Status",
              value: <TransactionStatus transaction={transaction} context={context} />,
            },
            {
              key: "amount",
              label: "Amount",
              value: <SignedAmount minor={transaction.amountMinor} digits={digits} />,
            },
            ...(detail.type === "opening-balance"
              ? [
                  {
                    key: "what",
                    label: "What",
                    value: `The balance the account's first imported statement, ${transaction.statement.reference}, opened with`,
                  },
                ]
              : [
                  {
                    key: "counterparty",
                    label: "Counterparty",
                    value:
                      counterparties.length === 0
                        ? "None given"
                        : `${counterparties.join(", ")}${ibans.length === 1 ? ` · ${formatIban(ibans[0])}` : ""}`,
                  },
                  {
                    key: "description",
                    label: "Description",
                    value:
                      remittance.length > 0 ? remittance.join("; ") : detail.information || "None",
                  },
                  {
                    key: "dates",
                    label: "Value date",
                    value: formatDate(detail.valueDate),
                  },
                  {
                    key: "statement",
                    label: "Statement",
                    value: `${transaction.statement.reference}, entry ${detail.bankReference}`,
                  },
                ]),
          ]}
        />
      </SurfaceCard>
      {parts.length > 1 ? (
        <SurfaceSection title="Payments" meta={`${parts.length} payments in one`} actions={null}>
          <SurfaceTable columns={PART_COLUMNS}>
            {parts.map((part, position) => (
              <SurfaceTableRow
                key={position}
                columns={PART_COLUMNS}
                cells={[
                  part.name ?? "",
                  part.iban === null ? "" : formatIban(part.iban),
                  part.remittance,
                ]}
              />
            ))}
          </SurfaceTable>
        </SurfaceSection>
      ) : null}
      {entries.length === 0 ? null : (
        <SurfaceSection
          title="Entries"
          meta={entries.length === 1 ? "1 entry" : `${entries.length} entries`}
          actions={null}
        >
          <SurfaceTable columns={ENTRY_COLUMNS}>
            {entries.map((entry) => (
              <SurfaceTableRow
                key={entry.id}
                columns={ENTRY_COLUMNS}
                cells={[
                  <Link
                    key="entry"
                    to={entry.path}
                    className="font-semibold text-[var(--bo-fg)] tabular-nums hover:underline"
                  >
                    {entry.name}
                  </Link>,
                  <span key="date" className="tabular-nums">
                    {formatDate(entry.postingDate)}
                  </span>,
                  entry.reversedByEntryId !== null ? (
                    <BackofficeStatusLight key="status" tone="waiting">
                      Reversed by {entryNames.get(entry.reversedByEntryId)}
                    </BackofficeStatusLight>
                  ) : entry.reversesEntryId !== null ? (
                    <BackofficeStatusLight key="status" tone="muted">
                      Reverses {entryNames.get(entry.reversesEntryId)}
                    </BackofficeStatusLight>
                  ) : null,
                ]}
              />
            ))}
          </SurfaceTable>
        </SurfaceSection>
      )}
      {state.status === "to-book" && detail.type === "entry" ? (
        <SurfaceSection
          title={
            transaction.amountMinor > 0n
              ? "Payment from a customer or supplier"
              : "Payment to a customer or supplier"
          }
          meta="Book it on their account, settling what it pays. Book anything else with an entry."
          actions={null}
        >
          {partyAccountOptions.length === 0 ? (
            <SurfacePanelBody>
              <p className="text-sm text-pretty text-[var(--bo-muted)]">
                The books have no customers or suppliers yet.{" "}
                <Link to={`${base}/parties`} className="text-[var(--bo-fg)] hover:underline">
                  Add them
                </Link>{" "}
                to book their payments here.
              </p>
            </SurfacePanelBody>
          ) : (
            <SurfacePanelBody>
              <Form method="get" className="flex flex-wrap items-center gap-3">
                <div className="min-w-72 flex-1">
                  <Select
                    aria-label="Customer or supplier"
                    name="party"
                    options={partyAccountOptions}
                    defaultValue={partyAccountId}
                    placeholder="Choose a customer or supplier"
                  />
                </div>
                <Button type="submit" variant="secondary">
                  Show open items
                </Button>
              </Form>
            </SurfacePanelBody>
          )}
          {partyAccountId === null ? null : (
            <Form method="post">
              <input type="hidden" name="partyAccountId" value={partyAccountId} />
              {items.length === 0 ? (
                <SurfacePanelBody>
                  <p className="text-sm text-pretty text-[var(--bo-muted)]">
                    Nothing they have open is for this payment to settle. Booking it leaves it open
                    on their account, to settle later.
                  </p>
                </SurfacePanelBody>
              ) : (
                <SurfaceTable columns={ITEM_COLUMNS}>
                  {items.map((item) => {
                    const label = `${journalCode(item)} ${item.entry.entryNumber}`;
                    const amount = preselected[item.id];
                    return (
                      <SurfaceTableRow
                        key={item.id}
                        columns={ITEM_COLUMNS}
                        cells={[
                          <input
                            key="settle"
                            type="checkbox"
                            name="settle"
                            value={item.id}
                            defaultChecked={amount !== undefined}
                            aria-label={`Settle ${label}`}
                            className="size-4 accent-[var(--bo-accent)]"
                          />,
                          <Link
                            key="entry"
                            to={entryPath(base, journalCode(item), item.entry.entryNumber)}
                            className="font-medium whitespace-nowrap text-[var(--bo-fg)] tabular-nums hover:underline"
                          >
                            {label}
                          </Link>,
                          [item.entry.reference, item.entry.description]
                            .filter((text) => text !== null && text !== "")
                            .join(" · "),
                          <span key="due" className="whitespace-nowrap tabular-nums">
                            {formatDate(item.dueDate)}
                          </span>,
                          <span key="outstanding" className="tabular-nums">
                            {formatAmount(item.outstandingMinor, digits)}
                          </span>,
                          <Input
                            key="amount"
                            aria-label={`Amount to settle of ${label}`}
                            name={`amount.${item.id}`}
                            density="compact"
                            inputMode="decimal"
                            className="w-32 text-right tabular-nums"
                            defaultValue={decimalAmount(amount ?? item.outstandingMinor, digits)}
                          />,
                        ]}
                      />
                    );
                  })}
                </SurfaceTable>
              )}
              <SurfacePanelFooter>
                <div className="mr-auto">
                  <FormError result={actionData} intent={SETTLE} />
                </div>
                <Button type="submit" variant="solid" disabled={navigation.state !== "idle"}>
                  Book payment
                </Button>
              </SurfacePanelFooter>
            </Form>
          )}
        </SurfaceSection>
      ) : null}
    </>
  );
}
