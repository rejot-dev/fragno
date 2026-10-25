import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { Select } from "@fragno-private/design-system/select";
import {
  SurfacePanel,
  SurfacePanelBody,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/surface-panel";
import { Form, Link, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/accounts";
import { ACCOUNT_KINDS, accountKind, DIMENSION_RULE_OPTIONS, type AccountKind } from "./books";
import {
  dimensionRules,
  formResult,
  parseForm,
  requireBooksSubmission,
  type FormResult,
} from "./books.server";
import { FormError, useFormReset } from "./forms";
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
  { label: "Code", align: "start" },
  { label: "Name", align: "start" },
  { label: "Kind", align: "start" },
  { label: "Currency", align: "start" },
  { label: "Status", align: "start" },
] as const;

export default function AccountsPage({ actionData }: Route.ComponentProps) {
  const { books, base, canSetUp } = useOutletContext<BooksOutletContext>();
  const navigation = useNavigation();
  const form = useFormReset(actionData, INTENT);
  return (
    <div className="space-y-6">
      <SurfacePanel caption={`Chart of accounts · ${books.accounts.length}`} actions={null}>
        <SurfaceTable columns={COLUMNS}>
          {books.accounts.map((account) => (
            <SurfaceTableRow
              key={account.id}
              columns={COLUMNS}
              cells={[
                account.code,
                <Link
                  key="name"
                  to={`${base}/accounts/${account.id}`}
                  className="font-medium text-[var(--bo-fg)]"
                >
                  {account.name}
                </Link>,
                ACCOUNT_KINDS[accountKind(account)].label,
                account.currency ?? "Any",
                account.active ? "Active" : "Inactive",
              ]}
            />
          ))}
        </SurfaceTable>
      </SurfacePanel>
      {canSetUp ? (
        <SurfacePanel caption="New account" actions={null}>
          <SurfacePanelBody>
            <Form method="post" ref={form} className="max-w-2xl space-y-4">
              <input type="hidden" name="intent" value={INTENT} />
              <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
                <Field label="Code">
                  <Input className="w-full" name="code" required />
                </Field>
                <Field label="Name">
                  <Input className="w-full" name="name" required />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
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
                <div className="grid gap-4 sm:grid-cols-3">
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
              <FormError result={actionData} intent={INTENT} />
              <Button type="submit" variant="accent" disabled={navigation.state !== "idle"}>
                Add account
              </Button>
            </Form>
          </SurfacePanelBody>
        </SurfacePanel>
      ) : null}
    </div>
  );
}
