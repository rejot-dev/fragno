import { Button, ButtonLink, IconButton } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Icon } from "@fragno-private/design-system/icon";
import { Input } from "@fragno-private/design-system/input";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { Select } from "@fragno-private/design-system/select";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import { SurfaceCard, SurfacePanelBody } from "@fragno-private/design-system/surface-panel";
import { useState } from "react";
import { Form, redirect, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import type { Books } from "../../workers/books/books";
import { today } from "../../workers/books/fiscal-years";
import { formatAmount, parseAmount } from "../../workers/books/money";
import { DocumentPreview } from "../documents/preview";
import type { Route } from "./+types/new-entry";
import { accountLabel, booksPath, documentPath, formatDate, indexBooks } from "./books";
import { requireBooks, requireBooksSubmission, type FormResult } from "./books.server";
import { FormError } from "./forms";
import type { BooksOutletContext } from "./layout";

export function meta() {
  return [{ title: "New entry · Bookkeeping" }];
}

/**
 * The document `documentId` names, to book with the entry: one to book, else its page, which shows
 * why not.
 */
async function requireDocumentToBook(
  context: Awaited<ReturnType<typeof requireBooks>>,
  params: Route.LoaderArgs["params"],
  documentId: string,
) {
  const document = await context.books.getDocument(documentId);
  if (!document) {
    throw new Response("This document does not exist.", { status: 404 });
  }
  if (document.state.status !== "to-book") {
    throw redirect(documentPath(booksPath(params), documentId));
  }
  return document;
}

/** A new entry, or with `?document=`, the entry booking that document. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const context = await requireBooks(request, params);
  const url = new URL(request.url);
  const documentId = url.searchParams.get("document");
  return {
    journalId: url.searchParams.get("journal"),
    today: today(),
    document: documentId === null ? null : await requireDocumentToBook(context, params, documentId),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const INTENT = "post";

const entrySchema = z.object({
  journalId: z.string().min(1, "Choose a journal."),
  postingDate: z.iso.date("Enter the posting date."),
  description: z
    .string()
    .trim()
    .min(1, "Describe the entry.")
    .max(500, "Use at most 500 characters."),
  reference: z
    .string()
    .trim()
    .max(100, "Use at most 100 characters for the reference.")
    .transform((reference) => (reference === "" ? null : reference)),
});

type Description = Awaited<ReturnType<Books["describe"]>>;
type PostingLine = Parameters<Books["postEntry"]>[0]["lines"][number];

/**
 * The lines of a submitted entry. Fields are named `lines.<n>.<field>`; rows the person left
 * empty are skipped. Returns the first problem as a message instead.
 */
function parseLines(
  form: Record<string, string>,
  books: Description,
  postingDate: string,
): PostingLine[] | string {
  const digits = new Map(books.currencies.map((row) => [row.code, row.minorUnitDigits]));
  const rows = Object.keys(form)
    .flatMap((key) => /^lines\.(\d+)\.accountId$/u.exec(key)?.[1] ?? [])
    .map(Number)
    .sort((a, b) => a - b);
  const lines: PostingLine[] = [];
  for (const row of rows) {
    const field = (name: string) => (form[`lines.${row}.${name}`] ?? "").trim();
    const label = `Line ${lines.length + 1}`;
    if (field("accountId") === "" && field("debit") === "" && field("credit") === "") {
      continue;
    }
    if (field("accountId") === "") {
      return `${label}: choose an account.`;
    }
    if ((field("debit") === "") === (field("credit") === "")) {
      return `${label}: enter either a debit or a credit.`;
    }
    const side = field("debit") === "" ? "credit" : "debit";
    const currency = field("currency") || books.functionalCurrency;
    const currencyDigits = digits.get(currency);
    if (currencyDigits === undefined) {
      return `${label}: choose one of the books' currencies.`;
    }
    const amountMinor = parseAmount(field(side), currencyDigits);
    if (amountMinor === null) {
      return `${label}: enter the amount as a number with at most ${currencyDigits} decimals, like 1234.50.`;
    }
    const functionalAmountMinor =
      currency === books.functionalCurrency
        ? amountMinor
        : parseAmount(field("functionalAmount"), digits.get(books.functionalCurrency)!);
    if (functionalAmountMinor === null) {
      return `${label}: enter the amount in ${books.functionalCurrency}.`;
    }
    const partyAccountId = field("partyAccountId");
    const dueDate = field("dueDate") || postingDate;
    if (!z.iso.date().safeParse(dueDate).success) {
      return `${label}: enter the due date.`;
    }
    lines.push({
      accountId: field("accountId"),
      side,
      currency,
      amountMinor,
      functionalAmountMinor,
      description: field("description"),
      dimensionValueIds: books.dimensions.flatMap((dimension) => {
        const valueId = field(`dimension.${dimension.id}`);
        return valueId === "" || valueId === "none" ? [] : [valueId];
      }),
      openItem: partyAccountId === "" ? null : { partyAccountId, dueDate },
    });
  }
  if (lines.length < 2) {
    return "An entry needs at least two lines.";
  }
  return lines;
}

/**
 * Posts the entry to its journal; the ledger checks it balances and follows its accounts' rules.
 * An entry booking a document records it as its source: dated as the document is the first time,
 * as it was then after a reversal.
 */
export async function action({ request, params }: Route.ActionArgs): Promise<FormResult> {
  const context = await requireBooksSubmission(request, params, "keep");
  const { user, books } = context;
  const form = Object.fromEntries(
    [...(await request.formData())].flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value] as const] : [],
    ),
  );
  const header = entrySchema.safeParse(form);
  if (!header.success) {
    return { intent: INTENT, error: header.error.issues[0]?.message ?? "Check the form." };
  }
  const { journalId, postingDate, description, reference } = header.data;
  const lines = parseLines(form, await books.describe(), postingDate);
  if (typeof lines === "string") {
    return { intent: INTENT, error: lines };
  }
  const entry = { journalId, postingDate, description, reference, postedBy: user.name, lines };
  if (form.documentId === undefined) {
    const outcome = await books.postEntry({
      ...entry,
      source: {
        type: "new",
        id: crypto.randomUUID(),
        kind: "manual",
        documentDate: postingDate,
        description,
      },
    });
    if (!outcome.ok) {
      return { intent: INTENT, error: outcome.message };
    }
    throw redirect(`${booksPath(params)}?journal=${journalId}`);
  }
  const document = await requireDocumentToBook(context, params, form.documentId);
  let source: Parameters<Books["bookDocument"]>[0]["source"] = { type: "existing" };
  if (document.source === null) {
    const documentDate = z.iso.date("Enter the document's date.").safeParse(form.documentDate);
    if (!documentDate.success) {
      return { intent: INTENT, error: documentDate.error.issues[0]?.message ?? "Check the form." };
    }
    source = { type: "new", documentDate: documentDate.data, description };
  }
  const outcome = await books.bookDocument({ documentId: document.id, source, entry });
  if (!outcome.ok) {
    return { intent: INTENT, error: outcome.message };
  }
  throw redirect(documentPath(booksPath(params), document.id));
}

/** What the form tracks of a line to show its totals and the fields its account needs. */
type LineState = {
  key: number;
  accountId: string;
  currency: string;
  debit: string;
  credit: string;
  functionalAmount: string;
};

export default function NewEntryPage({ loaderData, actionData }: Route.ComponentProps) {
  const { books, base } = useOutletContext<BooksOutletContext>();
  const navigation = useNavigation();
  const { document } = loaderData;
  const index = indexBooks(books);
  const blank = (key: number): LineState => ({
    key,
    accountId: "",
    currency: books.functionalCurrency,
    debit: "",
    credit: "",
    functionalAmount: "",
  });
  const [lines, setLines] = useState<LineState[]>(() => [blank(0), blank(1)]);
  const update = (key: number, change: Partial<LineState>) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...change } : line)),
    );
  };

  const functionalDigits = index.minorUnitDigits(books.functionalCurrency);
  const functionalAmount = (line: LineState, side: "debit" | "credit") => {
    const text = line.currency === books.functionalCurrency ? line[side] : line.functionalAmount;
    return line[side] === "" ? 0n : (parseAmount(text, functionalDigits) ?? 0n);
  };
  const debits = lines.reduce((sum, line) => sum + functionalAmount(line, "debit"), 0n);
  const credits = lines.reduce((sum, line) => sum + functionalAmount(line, "credit"), 0n);
  const activeAccounts = books.accounts.filter((account) => account.active);
  const difference = debits - credits;
  const grid =
    "grid items-center gap-2 md:grid-cols-[minmax(14rem,18rem)_1fr_8.5rem_8.5rem_2.25rem]";

  const form = (
    <SurfaceCard>
      <Form method="post">
        <SurfacePanelBody>
          {document === null ? null : (
            <div className="mb-4 grid gap-4 md:grid-cols-[11rem_1fr]">
              <input type="hidden" name="documentId" value={document.id} />
              {document.source === null ? (
                <Field label="Document date">
                  <Input className="w-full" type="date" name="documentDate" required />
                </Field>
              ) : (
                <p className="text-sm text-pretty text-[var(--bo-muted)] md:col-span-2">
                  Dated {formatDate(document.source.documentDate)}, as when it was first booked.
                </p>
              )}
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-[14rem_11rem_11rem_1fr]">
            <Field label="Journal">
              <Select
                name="journalId"
                options={books.journals.map((journal) => ({
                  label: `${journal.code} · ${journal.name}`,
                  value: journal.id,
                }))}
                defaultValue={loaderData.journalId ?? books.journals[0]?.id ?? null}
                required
              />
            </Field>
            <Field label="Date">
              <Input
                className="w-full"
                type="date"
                name="postingDate"
                defaultValue={loaderData.today}
                required
              />
            </Field>
            <Field label="Reference">
              <Input className="w-full" name="reference" placeholder="Invoice number" />
            </Field>
            <Field label="Description">
              <Input className="w-full" name="description" required />
            </Field>
          </div>
        </SurfacePanelBody>

        <div className="border-t border-[color:var(--bo-border)] px-4 pt-3 pb-2">
          <div
            aria-hidden="true"
            className={`${grid} hidden pb-2 text-xs font-medium text-[var(--bo-muted-2)] md:grid`}
          >
            <span>Account</span>
            <span>Description</span>
            <span className="text-right">Debit</span>
            <span className="text-right">Credit</span>
            <span />
          </div>
          {lines.map((line, position) => {
            const account = index.accounts.get(line.accountId);
            const label = `Line ${position + 1}`;
            const foreign = line.currency !== books.functionalCurrency;
            const control = account !== undefined && account.role !== "ordinary";
            const partyAccounts = control
              ? [...index.partyAccounts.values()].filter(
                  (partyAccount) => partyAccount.controlAccountId === account.id,
                )
              : [];
            const details = control || books.currencies.length > 1 || books.dimensions.length > 0;
            return (
              <fieldset
                key={line.key}
                className="space-y-2 border-b border-[var(--bo-border)] py-2 last:border-b-0"
                aria-label={label}
              >
                <div className={grid}>
                  <Select
                    aria-label={`${label} account`}
                    name={`lines.${line.key}.accountId`}
                    options={activeAccounts.map((row) => ({
                      label: accountLabel(row),
                      value: row.id,
                    }))}
                    placeholder="Choose an account"
                    value={line.accountId}
                    onValueChange={(accountId) => {
                      update(line.key, { accountId: accountId ?? "" });
                    }}
                  />
                  <Input
                    aria-label={`${label} description`}
                    name={`lines.${line.key}.description`}
                    placeholder="Optional"
                  />
                  <Input
                    aria-label={`${label} debit`}
                    name={`lines.${line.key}.debit`}
                    inputMode="decimal"
                    className="text-right tabular-nums"
                    value={line.debit}
                    onChange={(event) => {
                      update(line.key, { debit: event.target.value });
                    }}
                  />
                  <Input
                    aria-label={`${label} credit`}
                    name={`lines.${line.key}.credit`}
                    inputMode="decimal"
                    className="text-right tabular-nums"
                    value={line.credit}
                    onChange={(event) => {
                      update(line.key, { credit: event.target.value });
                    }}
                  />
                  <IconButton
                    label={`Remove ${label.toLowerCase()}`}
                    disabled={lines.length <= 2}
                    onClick={() => {
                      setLines((current) => current.filter((row) => row.key !== line.key));
                    }}
                  >
                    <Icon name="x" className="size-4" />
                  </IconButton>
                </div>
                {details ? (
                  <div className="flex flex-wrap items-center gap-2 md:pl-4">
                    {control ? (
                      <>
                        <div className="w-64">
                          <Select
                            aria-label={`${label} ${account.role === "receivable" ? "customer" : "supplier"}`}
                            name={`lines.${line.key}.partyAccountId`}
                            density="compact"
                            options={partyAccounts.map((partyAccount) => ({
                              label: `${partyAccount.code} · ${partyAccount.party.name}`,
                              value: partyAccount.id,
                            }))}
                            placeholder={
                              account.role === "receivable"
                                ? "Choose a customer"
                                : "Choose a supplier"
                            }
                          />
                        </div>
                        <label className="flex items-center gap-2 text-xs text-[var(--bo-muted)]">
                          Due
                          <Input
                            aria-label={`${label} due date`}
                            name={`lines.${line.key}.dueDate`}
                            density="compact"
                            type="date"
                          />
                        </label>
                      </>
                    ) : null}
                    {books.currencies.length > 1 ? (
                      <div className="w-24">
                        <Select
                          aria-label={`${label} currency`}
                          name={`lines.${line.key}.currency`}
                          density="compact"
                          options={books.currencies.map((row) => ({
                            label: row.code,
                            value: row.code,
                          }))}
                          value={line.currency}
                          onValueChange={(currency) => {
                            update(line.key, { currency: currency ?? books.functionalCurrency });
                          }}
                        />
                      </div>
                    ) : null}
                    {foreign ? (
                      <Input
                        aria-label={`${label} amount in ${books.functionalCurrency}`}
                        name={`lines.${line.key}.functionalAmount`}
                        density="compact"
                        inputMode="decimal"
                        className="text-right tabular-nums"
                        placeholder={`In ${books.functionalCurrency}`}
                        value={line.functionalAmount}
                        onChange={(event) => {
                          update(line.key, { functionalAmount: event.target.value });
                        }}
                      />
                    ) : null}
                    {books.dimensions.map((dimension) => (
                      <div key={dimension.id} className="w-48">
                        <Select
                          aria-label={`${label} ${dimension.name}`}
                          name={`lines.${line.key}.dimension.${dimension.id}`}
                          density="compact"
                          options={[
                            { label: `No ${dimension.name.toLowerCase()}`, value: "none" },
                            ...dimension.values.map((value) => ({
                              label: `${value.code} · ${value.name}`,
                              value: value.id,
                            })),
                          ]}
                          placeholder={dimension.name}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </fieldset>
            );
          })}
          <Button
            variant="ghost"
            className="mt-1"
            onClick={() => {
              setLines((current) => [
                ...current,
                blank(Math.max(...current.map((line) => line.key)) + 1),
              ]);
            }}
          >
            <Icon name="plus" className="size-4" />
            Add line
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--bo-border)] px-4 py-3">
          <div className="flex flex-wrap items-center gap-4 text-sm tabular-nums" role="status">
            <span className="text-[var(--bo-muted)]">
              Debits{" "}
              <span className="font-semibold text-[var(--bo-fg)]">
                {formatAmount(debits, functionalDigits)}
              </span>
            </span>
            <span className="text-[var(--bo-muted)]">
              Credits{" "}
              <span className="font-semibold text-[var(--bo-fg)]">
                {formatAmount(credits, functionalDigits)}
              </span>
            </span>
            {debits === 0n && credits === 0n ? null : difference === 0n ? (
              <BackofficeStatusLight tone="live">Balanced</BackofficeStatusLight>
            ) : (
              <BackofficeStatusLight tone="failed">
                Off by {formatAmount(difference < 0n ? -difference : difference, functionalDigits)}
              </BackofficeStatusLight>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ButtonLink
              variant="ghost"
              to={document === null ? base : documentPath(base, document.id)}
            >
              Cancel
            </ButtonLink>
            <Button type="submit" variant="solid" disabled={navigation.state !== "idle"}>
              {document === null ? "Post entry" : "Book document"}
            </Button>
          </div>
        </div>
        <div className="px-4 pb-3 empty:hidden">
          <FormError result={actionData} intent={INTENT} />
        </div>
      </Form>
    </SurfaceCard>
  );
  if (document === null) {
    return (
      <>
        <PageHeading eyebrow={books.name} title="New entry" meta={null} actions={null} />
        {form}
      </>
    );
  }
  return (
    <>
      <PageHeading
        eyebrow={books.name}
        title="Book document"
        meta={document.filename}
        actions={null}
      />
      {/* Above the form, not beside it: the form's lines need the page's whole width. */}
      <DocumentPreview base={base} document={document} />
      {form}
    </>
  );
}
