import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { Select } from "@fragno-private/design-system/select";
import {
  SurfaceFacts,
  SurfacePanel,
  SurfacePanelBody,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Form, Link, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import { formatAmount, parseAmount } from "../../workers/books/money";
import type { Route } from "./+types/party-account";
import { accountLabel, indexBooks } from "./books";
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
  return { items: await books.listOpenItems({ partyAccountId: params.partyAccountId }) };
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
  const entryLabel = (item: (typeof items)[number]) =>
    `${index.journals.get(item.entry.journalId)!.code} ${item.entry.entryNumber}`;
  const itemLabel = (item: (typeof items)[number]) =>
    `${entryLabel(item)} · ${item.entry.description} · ${amount(item.outstandingMinor, item.currency)} open`;
  const open = (side: "debit" | "credit") =>
    items.filter((item) => item.side === side && item.outstandingMinor > 0n);
  // Every allocation has one debit item, so listing those lists each allocation once.
  const allocations = items
    .filter((item) => item.side === "debit")
    .flatMap((item) => item.allocations)
    .sort((a, b) => a.allocatedAt.getTime() - b.allocatedAt.getTime());
  const outstanding = new Map<string, bigint>();
  for (const item of items) {
    const signed = item.side === "debit" ? item.outstandingMinor : -item.outstandingMinor;
    outstanding.set(item.currency, (outstanding.get(item.currency) ?? 0n) + signed);
  }
  const role = partyAccount.role === "customer" ? "Customer" : "Supplier";
  return (
    <div className="space-y-6">
      <SurfacePanel
        caption={`${partyAccount.party.name} · ${role} ${partyAccount.code}`}
        actions={
          <ButtonLink variant="ghost" to={`${base}/parties`}>
            All customers & suppliers
          </ButtonLink>
        }
      >
        <SurfaceFacts
          items={[
            { key: "role", label: "Role", value: role },
            { key: "control", label: "Control account", value: accountLabel(controlAccount) },
            {
              key: "balance",
              label: "Outstanding",
              value:
                outstanding.size === 0
                  ? "Nothing"
                  : [...outstanding]
                      .map(
                        ([currency, minor]) =>
                          `${amount(minor < 0n ? -minor : minor, currency)}${minor === 0n ? "" : minor < 0n ? " Cr" : " Dr"}`,
                      )
                      .join(" · "),
            },
          ]}
        />
      </SurfacePanel>
      <SurfacePanel caption="Open items" actions={null}>
        {items.length === 0 ? (
          <BackofficeSystemState
            flush
            tone="empty"
            label="Open items"
            title="Nothing posted yet"
            description={`Lines posted to ${accountLabel(controlAccount)} for this ${role.toLowerCase()} show here.`}
          />
        ) : (
          <SurfaceTable columns={ITEM_COLUMNS}>
            {items.map((item) => (
              <SurfaceTableRow
                key={item.id}
                columns={ITEM_COLUMNS}
                cells={[
                  item.entry.postingDate,
                  <Link key="entry" to={`${base}?journal=${item.entry.journalId}`}>
                    {entryLabel(item)}
                  </Link>,
                  item.entry.description,
                  item.dueDate,
                  item.side === "debit" ? amount(item.amountMinor, item.currency) : "",
                  item.side === "credit" ? amount(item.amountMinor, item.currency) : "",
                  item.outstandingMinor === 0n
                    ? "Settled"
                    : amount(item.outstandingMinor, item.currency),
                ]}
              />
            ))}
          </SurfaceTable>
        )}
      </SurfacePanel>
      {open("debit").length > 0 && open("credit").length > 0 ? (
        <SurfacePanel caption="Settle items" actions={null}>
          <SurfacePanelBody>
            <Form method="post" ref={form} className="max-w-3xl space-y-4">
              <input type="hidden" name="intent" value={ALLOCATE} />
              <div className="grid gap-4 sm:grid-cols-[1fr_1fr_10rem]">
                <Field label="Debit item">
                  <Select
                    name="debitItemId"
                    options={open("debit").map((item) => ({
                      label: itemLabel(item),
                      value: item.id,
                    }))}
                    placeholder="Choose a debit item"
                    required
                  />
                </Field>
                <Field label="Credit item">
                  <Select
                    name="creditItemId"
                    options={open("credit").map((item) => ({
                      label: itemLabel(item),
                      value: item.id,
                    }))}
                    placeholder="Choose a credit item"
                    required
                  />
                </Field>
                <Field label="Amount" description="Empty settles all it can.">
                  <Input className="w-full" name="amount" inputMode="decimal" />
                </Field>
              </div>
              <FormError result={actionData} intent={ALLOCATE} />
              <Button type="submit" variant="accent" disabled={navigation.state !== "idle"}>
                Settle
              </Button>
            </Form>
          </SurfacePanelBody>
        </SurfacePanel>
      ) : null}
      {allocations.length > 0 ? (
        <SurfacePanel caption="Settlements" actions={null}>
          <SurfaceTable columns={ALLOCATION_COLUMNS}>
            {allocations.map((allocation) => {
              const debit = itemsById.get(allocation.debitItemId)!;
              const credit = itemsById.get(allocation.creditItemId)!;
              return (
                <SurfaceTableRow
                  key={allocation.id}
                  columns={ALLOCATION_COLUMNS}
                  cells={[
                    allocation.allocatedAt.toISOString().slice(0, 10),
                    `${entryLabel(debit)} · ${debit.entry.description}`,
                    `${entryLabel(credit)} · ${credit.entry.description}`,
                    allocation.allocatedBy,
                    amount(allocation.amountMinor, debit.currency),
                    allocation.reversed ? (
                      "Undone"
                    ) : (
                      <Form key="undo" method="post">
                        <input type="hidden" name="intent" value={UNDO} />
                        <input type="hidden" name="allocationId" value={allocation.id} />
                        <Button
                          type="submit"
                          variant="ghost"
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
          <FormError result={actionData} intent={UNDO} />
        </SurfacePanel>
      ) : null}
    </div>
  );
}
