import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { Select } from "@fragno-private/design-system/select";
import {
  SurfaceFacts,
  SurfacePanel,
  SurfacePanelBody,
  SurfacePanelFooter,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Form, Link, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import { formatAmount } from "../../workers/books/money";
import type { Route } from "./+types/account";
import {
  ACCOUNT_KINDS,
  accountKind,
  accountLabel,
  DIMENSION_RULE_OPTIONS,
  indexBooks,
} from "./books";
import {
  dimensionRules,
  formResult,
  parseForm,
  requireBooks,
  requireBooksSubmission,
  type FormResult,
} from "./books.server";
import { FormError } from "./forms";
import type { BooksOutletContext } from "./layout";

export function meta() {
  return [{ title: "Account · Bookkeeping" }];
}

/** An account's lines, latest first. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { books } = await requireBooks(request, params);
  const { accounts } = await books.describe();
  if (!accounts.some((account) => account.id === params.accountId)) {
    throw new Response("This account does not exist.", { status: 404 });
  }
  const cursor = new URL(request.url).searchParams.get("cursor");
  return {
    lines: await books.listAccountLines({ accountId: params.accountId, cursor }),
    paged: cursor !== null,
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const INTENT = "update-account";

const updateSchema = z.object({
  intent: z.literal(INTENT),
  name: z
    .string()
    .trim()
    .min(1, "Enter the account's name.")
    .max(160, "Use at most 160 characters."),
  status: z.enum(["active", "inactive"]),
});

/** Renames an account, (de)activates it, or changes its dimension rules. */
export async function action({ request, params }: Route.ActionArgs): Promise<FormResult> {
  const { books } = await requireBooksSubmission(request, params, "set-up");
  const parsed = await parseForm(request, updateSchema);
  if ("refusal" in parsed) {
    return parsed.refusal;
  }
  const { dimensions } = await books.describe();
  return formResult(
    INTENT,
    await books.updateAccount({
      accountId: params.accountId,
      name: parsed.data.name,
      active: parsed.data.status === "active",
      dimensionRules: dimensionRules(parsed.form, dimensions),
    }),
  );
}

const COLUMNS = [
  { label: "Date", align: "start" },
  { label: "Entry", align: "start" },
  { label: "Description", align: "start" },
  { label: "Debit", align: "end" },
  { label: "Credit", align: "end" },
] as const;

export default function AccountPage({ loaderData, actionData, params }: Route.ComponentProps) {
  const { books, base, canSetUp } = useOutletContext<BooksOutletContext>();
  const navigation = useNavigation();
  const index = indexBooks(books);
  const account = index.accounts.get(params.accountId)!;
  const { lines, paged } = loaderData;
  const functionalDigits = index.minorUnitDigits(books.functionalCurrency);
  const accountPath = `${base}/accounts/${account.id}`;
  return (
    <div className="space-y-6">
      <SurfacePanel
        caption={accountLabel(account)}
        actions={
          <ButtonLink variant="ghost" to={`${base}/accounts`}>
            All accounts
          </ButtonLink>
        }
      >
        <SurfaceFacts
          items={[
            { key: "kind", label: "Kind", value: ACCOUNT_KINDS[accountKind(account)].label },
            {
              key: "side",
              label: "Normal side",
              value: account.normalSide === "debit" ? "Debit" : "Credit",
            },
            { key: "currency", label: "Currency", value: account.currency ?? "Any" },
            { key: "status", label: "Status", value: account.active ? "Active" : "Inactive" },
          ]}
        />
      </SurfacePanel>
      <SurfacePanel caption="Lines" actions={null}>
        {lines.items.length === 0 ? (
          <BackofficeSystemState
            flush
            tone="empty"
            label="Lines"
            title="Nothing posted yet"
            description="Lines posted to this account show here, latest first."
          />
        ) : (
          <SurfaceTable columns={COLUMNS}>
            {lines.items.map((line) => {
              const journal = index.journals.get(line.journalId)!;
              const amount = formatAmount(line.functionalAmountMinor, functionalDigits);
              const foreign =
                line.currency === books.functionalCurrency
                  ? null
                  : `${line.currency} ${formatAmount(line.amountMinor, index.minorUnitDigits(line.currency))}`;
              return (
                <SurfaceTableRow
                  key={line.id}
                  columns={COLUMNS}
                  cells={[
                    line.postingDate,
                    <Link key="entry" to={`${base}?journal=${journal.id}`}>
                      {journal.code} {line.entryNumber}
                    </Link>,
                    [line.description, foreign].filter((part) => part).join(" · "),
                    line.side === "debit" ? amount : "",
                    line.side === "credit" ? amount : "",
                  ]}
                />
              );
            })}
          </SurfaceTable>
        )}
        {lines.cursor !== null || paged ? (
          <SurfacePanelFooter>
            {paged ? (
              <ButtonLink variant="ghost" to={accountPath}>
                Latest lines
              </ButtonLink>
            ) : null}
            {lines.cursor !== null ? (
              <ButtonLink variant="secondary" to={`${accountPath}?cursor=${lines.cursor}`}>
                Earlier lines
              </ButtonLink>
            ) : null}
          </SurfacePanelFooter>
        ) : null}
      </SurfacePanel>
      {canSetUp ? (
        <SurfacePanel caption="Change account" actions={null}>
          <SurfacePanelBody>
            <p className="mb-4 max-w-2xl text-sm text-[var(--bo-muted)]">
              An account's kind, normal side, and currency never change, so what was posted keeps
              its meaning. Make it inactive and add a new account instead.
            </p>
            {/* Keyed by account so another account's page starts from its own values. */}
            <Form method="post" key={account.id} className="max-w-2xl space-y-4">
              <input type="hidden" name="intent" value={INTENT} />
              <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
                <Field label="Name">
                  <Input className="w-full" name="name" defaultValue={account.name} required />
                </Field>
                <Field label="Status">
                  <Select
                    name="status"
                    options={[
                      { label: "Active", value: "active" },
                      { label: "Inactive", value: "inactive" },
                    ]}
                    defaultValue={account.active ? "active" : "inactive"}
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
                        defaultValue={account.dimensionRules[dimension.id] ?? "optional"}
                      />
                    </Field>
                  ))}
                </div>
              ) : null}
              <FormError result={actionData} intent={INTENT} />
              <Button type="submit" variant="accent" disabled={navigation.state !== "idle"}>
                Save account
              </Button>
            </Form>
          </SurfacePanelBody>
        </SurfacePanel>
      ) : null}
    </div>
  );
}
