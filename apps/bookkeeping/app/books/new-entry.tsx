import { Button, ButtonLink, IconButton } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Icon } from "@fragno-private/design-system/icon";
import { Input } from "@fragno-private/design-system/input";
import { Select } from "@fragno-private/design-system/select";
import { SurfacePanel, SurfacePanelBody } from "@fragno-private/design-system/surface-panel";
import { useState } from "react";
import { Form, redirect, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import type { Books } from "../../workers/books/books";
import { today } from "../../workers/books/fiscal-years";
import { formatAmount, parseAmount } from "../../workers/books/money";
import type { Route } from "./+types/new-entry";
import { accountLabel, indexBooks } from "./books";
import { requireBooks, requireBooksSubmission, type FormResult } from "./books.server";
import { FormError } from "./forms";
import type { BooksOutletContext } from "./layout";

export function meta() {
  return [{ title: "New entry · Bookkeeping" }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireBooks(request, params);
  return { journalId: new URL(request.url).searchParams.get("journal"), today: today() };
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

/** Posts the entry to its journal; the ledger checks it balances and follows its accounts' rules. */
export async function action({ request, params }: Route.ActionArgs): Promise<FormResult> {
  const { user, books } = await requireBooksSubmission(request, params, "keep");
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
  const outcome = await books.postEntry({
    journalId,
    postingDate,
    description,
    reference,
    postedBy: user.name,
    source: { kind: "manual", documentDate: postingDate, description },
    lines,
  });
  if (!outcome.ok) {
    return { intent: INTENT, error: outcome.message };
  }
  const base = new URL(request.url).pathname.replace(/\/entries\/new$/u, "");
  throw redirect(`${base}?journal=${journalId}`);
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

  return (
    <SurfacePanel caption="New entry" actions={null}>
      <SurfacePanelBody>
        <Form method="post" className="space-y-6">
          <div className="grid gap-4 md:grid-cols-[1fr_12rem_10rem_2fr]">
            <Field label="Journal">
              <Select
                name="journalId"
                options={books.journals.map((journal) => ({
                  label: `${journal.code} ${journal.name}`,
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
              <Input className="w-full" name="reference" placeholder="e.g. invoice number" />
            </Field>
            <Field label="Description">
              <Input className="w-full" name="description" required />
            </Field>
          </div>

          <div className="space-y-3">
            {lines.map((line, position) => {
              const account = index.accounts.get(line.accountId);
              const label = `Line ${position + 1}`;
              const foreign = line.currency !== books.functionalCurrency;
              const partyAccounts = account
                ? [...index.partyAccounts.values()].filter(
                    (partyAccount) => partyAccount.controlAccountId === account.id,
                  )
                : [];
              return (
                <fieldset
                  key={line.key}
                  className="space-y-2 border-b border-[var(--bo-border)] pb-3"
                  aria-label={label}
                >
                  <div className="grid items-center gap-2 md:grid-cols-[16rem_1fr_9rem_9rem_auto]">
                    <Select
                      aria-label={`${label} account`}
                      name={`lines.${line.key}.accountId`}
                      options={activeAccounts.map((row) => ({
                        label: accountLabel(row),
                        value: row.id,
                      }))}
                      placeholder="Account"
                      value={line.accountId}
                      onValueChange={(accountId) => {
                        update(line.key, { accountId: accountId ?? "" });
                      }}
                    />
                    <Input
                      aria-label={`${label} description`}
                      name={`lines.${line.key}.description`}
                      placeholder="Description"
                    />
                    <Input
                      aria-label={`${label} debit`}
                      name={`lines.${line.key}.debit`}
                      inputMode="decimal"
                      placeholder="Debit"
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
                      placeholder="Credit"
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
                  <div className="flex flex-wrap gap-2">
                    {books.currencies.length > 1 ? (
                      <div className="w-28">
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
                        placeholder={`Amount in ${books.functionalCurrency}`}
                        value={line.functionalAmount}
                        onChange={(event) => {
                          update(line.key, { functionalAmount: event.target.value });
                        }}
                      />
                    ) : null}
                    {account && account.role !== "ordinary" ? (
                      <>
                        <div className="w-64">
                          <Select
                            aria-label={`${label} ${account.role === "receivable" ? "customer" : "supplier"}`}
                            name={`lines.${line.key}.partyAccountId`}
                            density="compact"
                            options={partyAccounts.map((partyAccount) => ({
                              label: `${partyAccount.code} ${partyAccount.party.name}`,
                              value: partyAccount.id,
                            }))}
                            placeholder={account.role === "receivable" ? "Customer" : "Supplier"}
                          />
                        </div>
                        <Input
                          aria-label={`${label} due date`}
                          name={`lines.${line.key}.dueDate`}
                          density="compact"
                          type="date"
                        />
                      </>
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
                              label: `${value.code} ${value.name}`,
                              value: value.id,
                            })),
                          ]}
                          placeholder={dimension.name}
                        />
                      </div>
                    ))}
                  </div>
                </fieldset>
              );
            })}
            <Button
              variant="ghost"
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

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-[var(--bo-muted)] tabular-nums" role="status">
              Debits {formatAmount(debits, functionalDigits)} · Credits{" "}
              {formatAmount(credits, functionalDigits)}
              {debits === credits
                ? ""
                : ` · Off by ${formatAmount(debits - credits, functionalDigits)}`}
            </p>
            <div className="flex gap-2">
              <ButtonLink variant="ghost" to={base}>
                Cancel
              </ButtonLink>
              <Button type="submit" variant="accent" disabled={navigation.state !== "idle"}>
                Post entry
              </Button>
            </div>
          </div>
          <FormError result={actionData} intent={INTENT} />
        </Form>
      </SurfacePanelBody>
    </SurfacePanel>
  );
}
