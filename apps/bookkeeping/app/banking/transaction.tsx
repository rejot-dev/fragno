import { Button, ButtonLink } from "@fragno-private/design-system/controls/button";
import { Input } from "@fragno-private/design-system/controls/input";
import { Select } from "@fragno-private/design-system/controls/select";
import { Callout } from "@fragno-private/design-system/feedback/callout";
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

import { describeTransaction } from "../../workers/books/banking/detail";
import { formatIban } from "../../workers/books/banking/iban";
import type { TransactionBooking } from "../../workers/books/banking/schema";
import { decimalAmount, formatAmount, parseAmount } from "../../workers/books/money";
import { ASK, BookkeeperProposal, ProposedLines } from "../books/bookkeeper-proposal";
import { askBookkeeper, withBookkeeperProgress } from "../books/bookkeeper.server";
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
import { settleableItems, suggestPayments } from "./matching.server";
import { SignedAmount, transactionEntries, TransactionStatus } from "./transactions";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: `${loaderData ? describeTransaction(loaderData.transaction.detail) : "Bank transaction"} · Bookkeeping`,
    },
  ];
}

type Context = Awaited<ReturnType<typeof requireBooks>>;

async function requireTransaction(context: Context, transactionId: string) {
  const transaction = await context.books.getTransaction(transactionId);
  if (!transaction) {
    throw new Response("This bank transaction does not exist.", { status: 404 });
  }
  return transaction;
}

/**
 * The transaction, how far the bookkeeping agent got with a request still unanswered, and while it
 * is to book, how the payment form starts, with the customer or supplier `?party=` chooses.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await requireBooks(request, params);
  const { subject: transaction, progress } = await withBookkeeperProgress(context, () =>
    requireTransaction(context, params.transactionId),
  );
  if (transaction.state.status !== "to-book") {
    return {
      transaction,
      progress,
      suggested: [],
      partyAccountId: null,
      items: [],
      preselected: {},
    };
  }
  const [suggestion] = await suggestPayments(context, await context.books.describe(), [
    { transaction, chosen: new URL(request.url).searchParams.get("party") },
  ]);
  return { transaction, progress, ...suggestion };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const SETTLE = "settle";

/**
 * Books the transaction as a payment by or to a customer or supplier, settling the open items
 * chosen for the amounts given, and what it paid beyond them stays open on their account; or asks
 * the bookkeeping agent, again, to propose how to book it.
 */
export async function action({ request, params }: Route.ActionArgs): Promise<FormResult> {
  const context = await requireBooksSubmission(request, params, "keep");
  const transaction = await requireTransaction(context, params.transactionId);
  const form = await request.formData();
  if (form.get("intent") === ASK) {
    const description = describeTransaction(transaction.detail);
    const asked = await askBookkeeper(
      context,
      [{ kind: "transaction", transaction: { id: transaction.id, description } }],
      "again",
    );
    return { intent: ASK, error: asked.ok ? null : asked.error };
  }
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
  const { transaction, progress, suggested, partyAccountId, items, preselected } = loaderData;
  const { detail, bankAccount, state, proposal } = transaction;
  const booking = proposal?.status === "proposed" ? proposal.booking : null;
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
              variant={booking?.type === "entry" ? "solid" : "secondary"}
              to={`${base}/entries/new?transaction=${transaction.id}`}
            >
              {booking?.type === "entry" ? "Review and book" : "Book with an entry"}
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
      {state.status === "to-book" ? (
        <BookkeeperProposal
          subject="transaction"
          proposal={proposal}
          progress={progress}
          proposed={
            proposal?.status === "proposed" ? (
              <ProposedBooking
                booking={proposal.booking}
                note={proposal.note}
                amountMinor={transaction.amountMinor}
                items={items}
                context={context}
              />
            ) : null
          }
          result={actionData}
        />
      ) : null}
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

/**
 * What the bookkeeping agent proposes for the transaction: a payment, which the payment form starts
 * from, settling `items` the form lists; or the lines of an entry, which Review and book fills the
 * new entry in from.
 */
function ProposedBooking({
  booking,
  note,
  amountMinor,
  items,
  context,
}: {
  booking: TransactionBooking;
  note: string;
  amountMinor: bigint;
  items: { id: string; entry: { journalId: string; entryNumber: number } }[];
  context: BooksOutletContext;
}) {
  const index = indexBooks(context.books);
  if (booking.type === "entry") {
    return (
      <>
        <SurfacePanelBody>
          <div className="space-y-3">
            <Callout tone="info" title="Proposed entry">
              {note}
            </Callout>
            <p className="text-sm text-[var(--bo-muted)]">
              {booking.description}
              {booking.reference === null ? "" : ` · ${booking.reference}`}, with the bank
              account&apos;s line. Review and book fills the new entry in from it.
            </p>
          </div>
        </SurfacePanelBody>
        <ProposedLines lines={booking.lines} context={context} />
      </>
    );
  }
  const partyAccount = index.partyAccounts.get(booking.partyAccountId);
  const settled = booking.settles.map((settlement) => {
    const item = items.find((candidate) => candidate.id === settlement.openItemId);
    const journal = item && index.journals.get(item.entry.journalId);
    return `${journal ? `${journal.code} ${item.entry.entryNumber}` : "an open item settled since"} for ${settlement.amount}`;
  });
  return (
    <SurfacePanelBody>
      <div className="space-y-3">
        <Callout tone="info" title="Proposed payment">
          {note}
        </Callout>
        <p className="text-sm text-pretty text-[var(--bo-muted)]">
          A payment {amountMinor > 0n ? "from" : "to"}{" "}
          {partyAccount
            ? `${partyAccount.party.name} (${partyAccount.code})`
            : "a customer or supplier the books no longer have"}
          {settled.length === 0
            ? ", settling nothing they have open yet"
            : `, settling ${settled.join(", ")}`}
          . The payment form below starts from it.
        </p>
      </div>
    </SurfacePanelBody>
  );
}
