import { Button } from "@fragno-private/design-system/button";
import { Input } from "@fragno-private/design-system/input";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfaceCard,
  SurfaceFacts,
  SurfacePanelFooter,
  SurfaceSection,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Form, Link, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import { today } from "../../workers/books/fiscal-years";
import { formatAmount, parseAmount } from "../../workers/books/money";
import type { Route } from "./+types/party-account";
import { Balance } from "./amounts";
import { accountLabel, entryPath, formatDate, indexBooks } from "./books";
import {
  formResult,
  parseForm,
  requireBooks,
  requireBooksSubmission,
  type FormResult,
} from "./books.server";
import { FormError, useFormReset } from "./forms";
import type { BooksOutletContext } from "./layout";

export function meta() {
  return [{ title: "Open items · Bookkeeping" }];
}

/** A customer's or supplier's open items, settled ones included, with their allocations. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { books } = await requireBooks(request, params);
  const { parties } = await books.describe();
  if (!parties.some((party) => party.accounts.some((row) => row.id === params.partyAccountId))) {
    throw new Response("This customer or supplier does not exist.", { status: 404 });
  }
  return {
    items: await books.listOpenItems({ partyAccountId: params.partyAccountId }),
    today: today(),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const ALLOCATE = "allocate";
const UNDO = "undo-allocation";

const allocationSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal(ALLOCATE),
    debitItemId: z.string().min(1, "Choose the debit item to settle."),
    creditItemId: z.string().min(1, "Choose the credit item to settle it with."),
    // Empty: as much as both items have outstanding.
    amount: z.string().trim(),
  }),
  z.object({ intent: z.literal(UNDO), allocationId: z.string().min(1) }),
]);

/** Settles a debit item against a credit item, such as an invoice against its payment, or undoes it. */
export async function action({ request, params }: Route.ActionArgs): Promise<FormResult> {
  const { user, books } = await requireBooksSubmission(request, params, "keep");
  const parsed = await parseForm(request, allocationSchema);
  if ("refusal" in parsed) {
    return parsed.refusal;
  }
  const submitted = parsed.data;
  if (submitted.intent === UNDO) {
    return formResult(
      UNDO,
      await books.reverseAllocation({
        allocationId: submitted.allocationId,
        reversedBy: user.name,
      }),
    );
  }
  const items = await books.listOpenItems({ partyAccountId: params.partyAccountId });
  const debit = items.find((item) => item.id === submitted.debitItemId);
  const credit = items.find((item) => item.id === submitted.creditItemId);
  if (!debit || !credit) {
    return { intent: ALLOCATE, error: "Choose open items of this customer or supplier." };
  }
  const { currencies } = await books.describe();
  const digits = currencies.find((row) => row.code === debit.currency)!.minorUnitDigits;
  const amountMinor = submitted.amount === "" ? null : parseAmount(submitted.amount, digits);
  if (amountMinor === 0n || (amountMinor === null && submitted.amount !== "")) {
    return {
      intent: ALLOCATE,
      error: `Enter the amount as a number with at most ${digits} decimals, like 1234.50.`,
    };
  }
  return formResult(
    ALLOCATE,
    await books.allocate({
      debitItemId: debit.id,
      creditItemId: credit.id,
      amountMinor,
      allocatedBy: user.name,
    }),
  );
}

const ITEM_COLUMNS = [
  { label: "Settle", align: "start" },
  { label: "Date", align: "start" },
  { label: "Entry", align: "start" },
  { label: "Description", align: "start" },
  { label: "Due", align: "start" },
  { label: "Debit", align: "end" },
  { label: "Credit", align: "end" },
  { label: "Outstanding", align: "end" },
] as const;

const ALLOCATION_COLUMNS = [
  { label: "Settled", align: "start" },
  { label: "Debit item", align: "start" },
  { label: "Credit item", align: "start" },
  { label: "By", align: "start" },
  { label: "Amount", align: "end" },
  { label: "", align: "end" },
] as const;

const SETTLE_FORM = "settle";

export default function PartyAccountPage({ loaderData, actionData, params }: Route.ComponentProps) {
  const { books, base } = useOutletContext<BooksOutletContext>();
  const navigation = useNavigation();
  const form = useFormReset(actionData, ALLOCATE);
  const index = indexBooks(books);
  const partyAccount = index.partyAccounts.get(params.partyAccountId)!;
  const controlAccount = index.accounts.get(partyAccount.controlAccountId)!;
  const { items } = loaderData;
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const amount = (minor: bigint, currency: string) =>
    `${currency === books.functionalCurrency ? "" : `${currency} `}${formatAmount(minor, index.minorUnitDigits(currency))}`;
  const journalCode = (item: (typeof items)[number]) =>
    index.journals.get(item.entry.journalId)!.code;
  const entryLink = (item: (typeof items)[number]) => (
    <Link
      key="entry"
      to={entryPath(base, journalCode(item), item.entry.entryNumber)}
      className="font-medium whitespace-nowrap text-[var(--bo-fg)] tabular-nums hover:underline"
    >
      {journalCode(item)} {item.entry.entryNumber}
    </Link>
  );
  const open = (side: "debit" | "credit") =>
    items.filter((item) => item.side === side && item.outstandingMinor > 0n);
  // Every allocation has one debit item, so listing those lists each allocation once.
  const allocations = items
    .filter((item) => item.side === "debit")
    .flatMap((item) => item.allocations)
    .sort((a, b) => b.allocatedAt.getTime() - a.allocatedAt.getTime());
  const outstanding = new Map<string, bigint>();
  for (const item of items) {
    const signed = item.side === "debit" ? item.outstandingMinor : -item.outstandingMinor;
    outstanding.set(item.currency, (outstanding.get(item.currency) ?? 0n) + signed);
  }
  const overdue = items.filter(
    (item) => item.outstandingMinor > 0n && item.dueDate < loaderData.today,
  );
  const settleable = open("debit").length > 0 && open("credit").length > 0;
  // Picking items only shows while there is something to settle.
  const itemColumns = settleable ? ITEM_COLUMNS : ITEM_COLUMNS.slice(1);
  const role = partyAccount.role === "customer" ? "Customer" : "Supplier";
  return (
    <>
      <PageHeading
        eyebrow={
          <Link to={`${base}/parties`} className="hover:underline">
            {role} {partyAccount.code}
          </Link>
        }
        title={partyAccount.party.name}
        meta={`Posts to ${accountLabel(controlAccount)}`}
        actions={null}
      />
      <SurfaceCard>
        <SurfaceFacts
          items={[
            {
              key: "balance",
              label: "Outstanding",
              value:
                outstanding.size === 0
                  ? "Nothing"
                  : [...outstanding].map(([currency, minor]) => (
                      <span key={currency} className="mr-3 tabular-nums">
                        {currency === books.functionalCurrency ? "" : `${currency} `}
                        <Balance minor={minor} digits={index.minorUnitDigits(currency)} />
                      </span>
                    )),
            },
            {
              key: "open",
              label: "Open items",
              value: String(items.filter((item) => item.outstandingMinor > 0n).length),
            },
            {
              key: "overdue",
              label: "Overdue",
              value:
                overdue.length === 0 ? (
                  "None"
                ) : (
                  <span className="text-[var(--bo-failed)]">
                    {overdue.length} {overdue.length === 1 ? "item" : "items"}
                  </span>
                ),
            },
          ]}
        />
      </SurfaceCard>
      <SurfaceSection
        title="Open items"
        meta={
          settleable ? "Pick a debit and a credit item to settle them against each other." : null
        }
        actions={null}
      >
        {items.length === 0 ? (
          <BackofficeSystemState
            flush
            tone="empty"
            label="Open items"
            title="Nothing posted yet"
            description={`Lines posted to ${accountLabel(controlAccount)} for this ${role.toLowerCase()} show here.`}
          />
        ) : (
          <SurfaceTable columns={itemColumns}>
            {items.map((item) => {
              const settled = item.outstandingMinor === 0n;
              const sideItems = open(item.side);
              const pick = settled ? (
                ""
              ) : (
                <input
                  key="pick"
                  type="radio"
                  form={SETTLE_FORM}
                  name={item.side === "debit" ? "debitItemId" : "creditItemId"}
                  value={item.id}
                  // With one item open on its side, there is nothing to pick.
                  defaultChecked={sideItems.length === 1}
                  aria-label={`Settle ${journalCode(item)} ${item.entry.entryNumber}`}
                  className="size-4 accent-[var(--bo-accent)]"
                />
              );
              return (
                <SurfaceTableRow
                  key={item.id}
                  columns={itemColumns}
                  cells={[
                    ...(settleable ? [pick] : []),
                    <span key="date" className="whitespace-nowrap tabular-nums">
                      {formatDate(item.entry.postingDate)}
                    </span>,
                    entryLink(item),
                    item.entry.description,
                    <span
                      key="due"
                      className={`whitespace-nowrap tabular-nums ${!settled && item.dueDate < loaderData.today ? "text-[var(--bo-failed)]" : ""}`}
                    >
                      {formatDate(item.dueDate)}
                    </span>,
                    item.side === "debit" ? amount(item.amountMinor, item.currency) : "",
                    item.side === "credit" ? amount(item.amountMinor, item.currency) : "",
                    settled ? (
                      <BackofficeStatusLight key="settled" tone="live">
                        Settled
                      </BackofficeStatusLight>
                    ) : (
                      <span key="outstanding" className="font-semibold text-[var(--bo-fg)]">
                        {amount(item.outstandingMinor, item.currency)}
                      </span>
                    ),
                  ]}
                />
              );
            })}
          </SurfaceTable>
        )}
        {settleable ? (
          <SurfacePanelFooter>
            <Form
              id={SETTLE_FORM}
              method="post"
              ref={form}
              className="flex w-full flex-wrap items-center justify-end gap-3"
            >
              <input type="hidden" name="intent" value={ALLOCATE} />
              <div className="mr-auto">
                <FormError result={actionData} intent={ALLOCATE} />
              </div>
              <label className="flex items-center gap-2 text-sm text-[var(--bo-muted)]">
                Amount
                <Input
                  className="w-36 text-right tabular-nums"
                  density="compact"
                  name="amount"
                  inputMode="decimal"
                  placeholder="All it can"
                />
              </label>
              <Button type="submit" variant="solid" disabled={navigation.state !== "idle"}>
                Settle
              </Button>
            </Form>
          </SurfacePanelFooter>
        ) : null}
      </SurfaceSection>
      {allocations.length > 0 ? (
        <SurfaceSection title="Settlements" meta={null} actions={null}>
          <SurfaceTable columns={ALLOCATION_COLUMNS}>
            {allocations.map((allocation) => {
              const debit = itemsById.get(allocation.debitItemId)!;
              const credit = itemsById.get(allocation.creditItemId)!;
              return (
                <SurfaceTableRow
                  key={allocation.id}
                  columns={ALLOCATION_COLUMNS}
                  cells={[
                    <span key="date" className="whitespace-nowrap tabular-nums">
                      {formatDate(allocation.allocatedAt.toISOString().slice(0, 10))}
                    </span>,
                    <span key="debit">
                      {entryLink(debit)} {debit.entry.description}
                    </span>,
                    <span key="credit">
                      {entryLink(credit)} {credit.entry.description}
                    </span>,
                    allocation.allocatedBy,
                    amount(allocation.amountMinor, debit.currency),
                    allocation.reversed ? (
                      <BackofficeStatusLight key="undone" tone="muted">
                        Undone
                      </BackofficeStatusLight>
                    ) : (
                      <Form key="undo" method="post">
                        <input type="hidden" name="intent" value={UNDO} />
                        <input type="hidden" name="allocationId" value={allocation.id} />
                        <Button
                          type="submit"
                          variant="ghost"
                          className="min-h-8"
                          disabled={navigation.state !== "idle"}
                        >
                          Undo
                        </Button>
                      </Form>
                    ),
                  ]}
                />
              );
            })}
          </SurfaceTable>
          <div className="px-4 pb-3 empty:hidden">
            <FormError result={actionData} intent={UNDO} />
          </div>
        </SurfaceSection>
      ) : null}
    </>
  );
}
