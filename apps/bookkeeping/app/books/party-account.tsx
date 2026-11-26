import { Button } from "@fragno-private/design-system/controls/button";
import { Field } from "@fragno-private/design-system/controls/field";
import { Input } from "@fragno-private/design-system/controls/input";
import { TextArea } from "@fragno-private/design-system/controls/text-area";
import { Callout } from "@fragno-private/design-system/feedback/callout";
import { BackofficeStatusLight } from "@fragno-private/design-system/feedback/status-light";
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
import { Form, Link, redirect, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import { formatIban, parseIban } from "../../workers/books/banking/iban";
import { today } from "../../workers/books/fiscal-years";
import { formatAmount, parseAmount } from "../../workers/books/money";
import type { PartyDetails } from "../../workers/books/party-details/party-details";
import type { Route } from "./+types/party-account";
import { Balance } from "./amounts";
import { usePollWhile } from "./bookkeeper-proposal";
import { accountLabel, booksPath, entryPath, formatDate, indexBooks } from "./books";
import {
  formResult,
  parseForm,
  requireBooks,
  requireBooksSubmission,
  type FormResult,
} from "./books.server";
import {
  readCompanyDetailsLookup,
  startCompanyDetailsLookup,
  type CompanyDetailsLookup,
} from "./company-details.server";
import { FormError, useFormReset } from "./forms";
import type { BooksOutletContext } from "./layout";

export function meta() {
  return [{ title: "Open items · Bookkeeping" }];
}

/** The customer or supplier with this account, as the ledger lists it; a 404 when it has none. */
async function requireParty(
  books: Awaited<ReturnType<typeof requireBooks>>["books"],
  partyAccountId: string,
) {
  const { parties } = await books.describe();
  const party = parties.find((candidate) =>
    candidate.accounts.some((row) => row.id === partyAccountId),
  );
  if (!party) {
    throw new Response("This customer or supplier does not exist.", { status: 404 });
  }
  return { party, account: party.accounts.find((row) => row.id === partyAccountId)! };
}

/** The page of this customer's or supplier's account. */
function partyPath(params: Route.ActionArgs["params"]) {
  return `${booksPath(params)}/parties/${params.partyAccountId}`;
}

/**
 * A customer's or supplier's open items, settled ones included, with their allocations; its
 * company details; and where the lookup `?lookup=` names stands, read as the person.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await requireBooks(request, params);
  const { party } = await requireParty(context.books, params.partyAccountId);
  const requestId = new URL(request.url).searchParams.get(LOOKUP_PARAM);
  const [items, details, lookup] = await Promise.all([
    context.books.listOpenItems({ partyAccountIds: [params.partyAccountId] }),
    context.books.getPartyDetails(party.id),
    requestId === null
      ? null
      : readCompanyDetailsLookup(request, context, { partyId: party.id, requestId }),
  ]);
  return { items, today: today(), details, lookup, lookupId: requestId };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const ALLOCATE = "allocate";
const UNDO = "undo-allocation";
const SAVE_DETAILS = "save-details";
const LOOK_UP_DETAILS = "look-up-details";
const LOOKUP_PARAM = "lookup";

const detailField = z.string().transform((value) => {
  const trimmed = value.replace(/\s+/gu, " ").trim();
  return trimmed === "" ? null : trimmed;
});

const partyFormSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal(ALLOCATE),
    debitItemId: z.string().min(1, "Choose the debit item to settle."),
    creditItemId: z.string().min(1, "Choose the credit item to settle it with."),
    // Empty: as much as both items have outstanding.
    amount: z.string().trim(),
  }),
  z.object({ intent: z.literal(UNDO), allocationId: z.string().min(1) }),
  z.object({
    intent: z.literal(SAVE_DETAILS),
    registrationNumber: detailField,
    vatNumber: detailField,
    iban: detailField,
    address: detailField,
  }),
  z.object({
    intent: z.literal(LOOK_UP_DETAILS),
    // The failed lookup's request ID this retries, or empty for a new lookup.
    retrying: z.string().transform((value) => (value === "" ? null : value)),
  }),
]);

/** A lookup that was not asked, with the request ID its retry asks with. */
type LookupFailure = { intent: typeof LOOK_UP_DETAILS; error: string; requestId: string };

/**
 * Settles a debit item against a credit item, such as an invoice against its payment, or undoes
 * it; saves the company details; or starts looking them up in the person's own connections.
 */
export async function action({
  request,
  params,
}: Route.ActionArgs): Promise<FormResult | LookupFailure | Response> {
  const context = await requireBooksSubmission(request, params, "keep");
  const { user, books } = context;
  const parsed = await parseForm(request, partyFormSchema);
  if ("refusal" in parsed) {
    return parsed.refusal;
  }
  const submitted = parsed.data;
  if (submitted.intent === LOOK_UP_DETAILS) {
    const { party, account } = await requireParty(books, params.partyAccountId);
    const started = await startCompanyDetailsLookup(
      request,
      context,
      { id: party.id, name: party.name, role: account.role },
      submitted.retrying,
    );
    if (!started.ok) {
      return { intent: LOOK_UP_DETAILS, error: started.error, requestId: started.requestId };
    }
    return redirect(
      `${partyPath(params)}?${LOOKUP_PARAM}=${encodeURIComponent(started.requestId)}`,
    );
  }
  if (submitted.intent === SAVE_DETAILS) {
    const { party } = await requireParty(books, params.partyAccountId);
    const { intent: _, ...details } = submitted;
    const iban = details.iban === null ? null : parseIban(details.iban);
    if (details.iban !== null && iban === null) {
      return { intent: SAVE_DETAILS, error: "Enter the IBAN as the bank gives it." };
    }
    const saved = await books.savePartyDetails({
      partyId: party.id,
      details: { ...details, iban },
      updatedBy: user.name,
    });
    if (!saved.ok) {
      return formResult(SAVE_DETAILS, saved);
    }
    // Saved: what a lookup found no longer fills in the form.
    return redirect(partyPath(params));
  }
  if (submitted.intent === UNDO) {
    return formResult(
      UNDO,
      await books.reverseAllocation({
        allocationId: submitted.allocationId,
        reversedBy: user.name,
      }),
    );
  }
  const items = await books.listOpenItems({ partyAccountIds: [params.partyAccountId] });
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
  const { items, details, lookup, lookupId } = loaderData;
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
      <CompanyDetails
        // The form's inputs keep what they show across navigations, so another party, another
        // lookup, or another save fills it in afresh.
        key={`${params.partyAccountId}:${lookupId ?? ""}:${details.updatedAt?.toISOString() ?? ""}`}
        details={details}
        lookup={lookup}
        role={role.toLowerCase()}
        actionData={actionData}
      />
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

const DETAIL_FIELDS = [
  { name: "registrationNumber", label: "Registration number", hint: "Such as a KvK number" },
  { name: "vatNumber", label: "VAT number", hint: null },
  { name: "iban", label: "IBAN", hint: null },
] as const satisfies readonly { name: keyof PartyDetails; label: string; hint: string | null }[];

/**
 * The company details the books keep, and filling them in from the person's own connections: what
 * a lookup found fills in the form, for them to check and save.
 */
function CompanyDetails({
  details,
  lookup,
  role,
  actionData,
}: {
  details: PartyDetails & { updatedAt: Date | null; updatedBy: string | null };
  lookup: CompanyDetailsLookup | null;
  role: string;
  actionData: FormResult | LookupFailure | undefined;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  usePollWhile(lookup?.status === "looking");
  const found = lookup?.status === "found" ? lookup.details : null;
  const value = (name: keyof PartyDetails) => {
    // An IBAN the source gave that is not one fills in as given, so saving it unseen fails.
    if (name === "iban" && lookup?.status === "found" && lookup.invalidIban !== null) {
      return lookup.invalidIban;
    }
    const known = found?.[name] ?? details[name];
    return name === "iban" && known !== null ? formatIban(known) : (known ?? "");
  };
  return (
    <SurfaceSection
      title="Company details"
      meta={
        details.updatedBy === null || details.updatedAt === null
          ? null
          : `Saved by ${details.updatedBy} on ${formatDate(details.updatedAt.toISOString().slice(0, 10))}`
      }
      actions={
        <Form method="post">
          <input type="hidden" name="intent" value={LOOK_UP_DETAILS} />
          <input
            type="hidden"
            name="retrying"
            value={actionData && "requestId" in actionData ? actionData.requestId : ""}
          />
          <Button type="submit" variant="secondary" disabled={busy || lookup?.status === "looking"}>
            Fill in from your connections
          </Button>
        </Form>
      }
    >
      <SurfacePanelBody>
        <div className="space-y-4">
          <FormError result={actionData} intent={LOOK_UP_DETAILS} />
          {lookup ? <LookupState lookup={lookup} role={role} /> : null}
          {/* Keyed by what fills it in, so a lookup's answer replaces what the form showed. */}
          <Form method="post" className="space-y-4" key={found ? "found" : "saved"}>
            <input type="hidden" name="intent" value={SAVE_DETAILS} />
            <div className="grid gap-4 sm:grid-cols-3">
              {DETAIL_FIELDS.map((field) => (
                <Field
                  key={field.name}
                  label={field.label}
                  {...(field.hint ? { description: field.hint } : {})}
                >
                  <Input className="w-full" name={field.name} defaultValue={value(field.name)} />
                </Field>
              ))}
            </div>
            <Field label="Address">
              <TextArea name="address" rows={2} defaultValue={value("address")} />
            </Field>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <div className="mr-auto">
                <FormError result={actionData} intent={SAVE_DETAILS} />
              </div>
              <Button type="submit" variant="solid" disabled={busy}>
                Save
              </Button>
            </div>
          </Form>
        </div>
      </SurfacePanelBody>
    </SurfaceSection>
  );
}

/** Where a lookup in the person's own connections stands. */
function LookupState({ lookup, role }: { lookup: CompanyDetailsLookup; role: string }) {
  switch (lookup.status) {
    case "looking":
      return (
        <BackofficeStatusLight tone="live">
          Looking for the {role} in your connections
        </BackofficeStatusLight>
      );
    case "found":
      return (
        <Callout tone="info" title={`Found in ${lookup.source}`}>
          Check what it filled in below, and save it.
          {lookup.invalidIban === null
            ? null
            : ` The IBAN it gave, ${lookup.invalidIban}, is not a valid IBAN: correct it before saving.`}
        </Callout>
      );
    case "not-found":
      return (
        <Callout tone="waiting" title="Nothing found">
          {lookup.reason}
        </Callout>
      );
    case "refused":
      return (
        <Callout tone="waiting" title="Let Bookkeeping into your personal workspace">
          {lookup.allowUrl === null ? (
            lookup.message
          ) : (
            <>
              Bookkeeping looks in your own connections once you let it into your personal workspace
              for this client.{" "}
              <a
                href={lookup.allowUrl}
                target="_blank"
                rel="noreferrer"
                className="font-semibold underline"
              >
                Allow it in Leyway
              </a>
              , then fill in again.
            </>
          )}
        </Callout>
      );
    case "failed":
      return (
        <Callout tone="failed" title="The lookup failed">
          {lookup.reason}
        </Callout>
      );
    default:
      throw new Error("Unsupported lookup state.", { cause: lookup satisfies never });
  }
}
