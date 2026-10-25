import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { Select } from "@fragno-private/design-system/select";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfaceCard,
  SurfaceTable,
  SurfaceTableGroupRow,
  SurfaceTableRow,
} from "@fragno-private/design-system/surface-panel";
import { Fragment } from "react";
import { Link, useOutletContext } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/accounts";
import { AccountName } from "./amounts";
import { ACCOUNT_KINDS, DIMENSION_RULE_OPTIONS, type AccountKind } from "./books";
import {
  dimensionRules,
  formResult,
  parseForm,
  requireBooksSubmission,
  type FormResult,
} from "./books.server";
import { FormDialog } from "./forms";
import type { BooksOutletContext } from "./layout";

export function meta() {
  return [{ title: "Accounts · Bookkeeping" }];
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const INTENT = "create-account";
const KINDS = Object.keys(ACCOUNT_KINDS) as AccountKind[];

const accountSchema = z.object({
  intent: z.literal(INTENT),
  code: z.string().trim().min(1, "Enter the account's code.").max(20, "Use at most 20 characters."),
  name: z
    .string()
    .trim()
    .min(1, "Enter the account's name.")
    .max(160, "Use at most 160 characters."),
  kind: z.enum(KINDS, "Choose what kind of account it is."),
  normalSide: z.enum(["usual", "debit", "credit"]),
  // A currency's code, or any currency.
  currency: z.string().min(1),
});

/** Assets and expenses usually grow with debits; liabilities, equity, and revenue with credits. */
const USUAL_SIDES = {
  asset: "debit",
  liability: "credit",
  equity: "credit",
  revenue: "credit",
  expense: "debit",
} as const;

/** Adds an account to the chart. */
export async function action({ request, params }: Route.ActionArgs): Promise<FormResult> {
  const { books } = await requireBooksSubmission(request, params, "set-up");
  const parsed = await parseForm(request, accountSchema);
  if ("refusal" in parsed) {
    return parsed.refusal;
  }
  const { code, name, kind, normalSide, currency } = parsed.data;
  const { classification } = ACCOUNT_KINDS[kind];
  const { dimensions } = await books.describe();
  return formResult(
    INTENT,
    await books.createAccount({
      code,
      name,
      classification,
      normalSide: normalSide === "usual" ? USUAL_SIDES[classification.type] : normalSide,
      currency: currency === "any" ? null : currency,
      dimensionRules: dimensionRules(parsed.form, dimensions),
    }),
  );
}

const COLUMNS = [
  { label: "Account", align: "start" },
  { label: "", align: "end" },
] as const;

/** The chart's sections, in the order balance sheet and income statement show them. */
const TYPE_GROUPS = [
  { type: "asset", label: "Assets" },
  { type: "liability", label: "Liabilities" },
  { type: "equity", label: "Equity" },
  { type: "revenue", label: "Revenue" },
  { type: "expense", label: "Expenses" },
] as const;

export default function AccountsPage({ actionData }: Route.ComponentProps) {
  const { books, base, canSetUp } = useOutletContext<BooksOutletContext>();
  const dimensionNames = new Map(
    books.dimensions.map((dimension) => [dimension.id, dimension.name]),
  );
  return (
    <>
      <PageHeading
        eyebrow={books.name}
        title="Chart of accounts"
        meta={`${books.accounts.length} accounts`}
        actions={
          canSetUp ? (
            <FormDialog
              label="New account"
              variant="solid"
              title="New account"
              description="An account's kind, normal side, and currency never change once it exists."
              intent={INTENT}
              resultIntent={INTENT}
              submit="Add account"
              result={actionData}
            >
              <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
                <Field label="Code">
                  <Input className="w-full" name="code" required />
                </Field>
                <Field label="Name">
                  <Input className="w-full" name="name" required />
                </Field>
              </div>
              <Field label="Kind">
                <Select
                  name="kind"
                  options={KINDS.map((kind) => ({
                    label: ACCOUNT_KINDS[kind].label,
                    value: kind,
                  }))}
                  placeholder="Choose a kind"
                  required
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Normal side">
                  <Select
                    name="normalSide"
                    options={[
                      { label: "Usual for its kind", value: "usual" },
                      { label: "Debit", value: "debit" },
                      { label: "Credit", value: "credit" },
                    ]}
                    defaultValue="usual"
                  />
                </Field>
                <Field label="Currency">
                  <Select
                    name="currency"
                    options={[
                      { label: "Any currency", value: "any" },
                      ...books.currencies.map((row) => ({ label: row.code, value: row.code })),
                    ]}
                    defaultValue="any"
                  />
                </Field>
              </div>
              {books.dimensions.length > 0 ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  {books.dimensions.map((dimension) => (
                    <Field key={dimension.id} label={dimension.name}>
                      <Select
                        name={`dimension.${dimension.id}`}
                        options={DIMENSION_RULE_OPTIONS}
                        defaultValue="optional"
                      />
                    </Field>
                  ))}
                </div>
              ) : null}
            </FormDialog>
          ) : null
        }
      />
      <SurfaceCard>
        <SurfaceTable columns={COLUMNS}>
          {TYPE_GROUPS.map((group) => {
            const accounts = books.accounts.filter((account) => account.type === group.type);
            return accounts.length === 0 ? null : (
              <Fragment key={group.type}>
                <SurfaceTableGroupRow columns={COLUMNS}>
                  <span className="text-xs font-semibold text-[var(--bo-muted)]">
                    {group.label}
                  </span>
                </SurfaceTableGroupRow>
                {accounts.map((account) => (
                  <SurfaceTableRow
                    key={account.id}
                    columns={COLUMNS}
                    cells={[
                      <Link
                        key="name"
                        to={`${base}/accounts/${account.id}`}
                        className={`hover:underline ${account.active ? "text-[var(--bo-fg)]" : "text-[var(--bo-muted-2)]"}`}
                      >
                        <AccountName account={account} />
                      </Link>,
                      <span key="notes" className="inline-flex flex-wrap justify-end gap-1.5">
                        {account.role === "ordinary" ? null : (
                          <BackofficeStatusLight tone="info" dot={false}>
                            {account.role === "receivable" ? "Customers" : "Suppliers"}
                          </BackofficeStatusLight>
                        )}
                        {account.currency === null ? null : (
                          <BackofficeStatusLight tone="info" dot={false}>
                            {account.currency} only
                          </BackofficeStatusLight>
                        )}
                        {Object.entries(account.dimensionRules).map(([dimensionId, rule]) => (
                          <BackofficeStatusLight key={dimensionId} tone="muted" dot={false}>
                            {dimensionNames.get(dimensionId)}{" "}
                            {rule === "required" ? "required" : "not allowed"}
                          </BackofficeStatusLight>
                        ))}
                        {account.active ? null : (
                          <BackofficeStatusLight tone="muted">Inactive</BackofficeStatusLight>
                        )}
                      </span>,
                    ]}
                  />
                ))}
              </Fragment>
            );
          })}
        </SurfaceTable>
      </SurfaceCard>
    </>
  );
}
