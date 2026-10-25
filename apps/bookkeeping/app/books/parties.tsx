import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { Select } from "@fragno-private/design-system/select";
import {
  SurfaceCard,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useState } from "react";
import { Link, useOutletContext } from "react-router";
import { z } from "zod";

import { CONTROL_ROLES, usualControlAccount } from "../../workers/books/parties";
import type { Route } from "./+types/parties";
import { accountLabel } from "./books";
import { parseForm, requireBooksSubmission, type FormResult } from "./books.server";
import { FormDialog } from "./forms";
import type { BooksOutletContext } from "./layout";

export function meta() {
  return [{ title: "Customers & suppliers · Bookkeeping" }];
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const INTENT = "add-party-account";

const ROLE_LABELS = { customer: "Customer", supplier: "Supplier" } as const;

const partyAccountSchema = z.object({
  intent: z.literal(INTENT),
  // An existing party's ID, or a new party named `name`.
  partyId: z.string().min(1),
  name: z.string().trim().max(160, "Use at most 160 characters."),
  role: z.enum(["customer", "supplier"], "Choose customer or supplier."),
  code: z.string().trim().min(1, "Enter the code.").max(20, "Use at most 20 characters."),
  // An account's ID, or the books' only control account for the role.
  controlAccountId: z.string().min(1),
});

/** Makes a party, new or existing, a customer or a supplier. */
export async function action({ request, params }: Route.ActionArgs): Promise<FormResult> {
  const { books } = await requireBooksSubmission(request, params, "keep");
  const parsed = await parseForm(request, partyAccountSchema);
  if ("refusal" in parsed) {
    return parsed.refusal;
  }
  const { partyId, name, role, code } = parsed.data;
  const refuse = (error: string): FormResult => ({ intent: INTENT, error });
  const controlAccountId =
    parsed.data.controlAccountId !== "usual"
      ? parsed.data.controlAccountId
      : (usualControlAccount((await books.describe()).accounts, role)?.id ?? null);
  if (controlAccountId === null) {
    return refuse(`Choose the ${CONTROL_ROLES[role]} account ${role}s post to.`);
  }
  if (partyId === "new" && name === "") {
    return refuse("Enter the name of the new party.");
  }
  const outcome = await books.createPartyAccount({
    party: partyId === "new" ? { name } : { id: partyId },
    role,
    code,
    controlAccountId,
  });
  return outcome.ok ? { intent: INTENT, error: null } : refuse(outcome.message);
}

const COLUMNS = [
  { label: "Name", align: "start" },
  { label: "Customer", align: "start" },
  { label: "Supplier", align: "start" },
] as const;

export default function PartiesPage({ actionData }: Route.ComponentProps) {
  const { books, base } = useOutletContext<BooksOutletContext>();
  const [partyId, setPartyId] = useState("new");
  const controlAccounts = books.accounts.filter(
    (account) => account.active && account.role !== "ordinary",
  );
  const roleCell = (party: (typeof books.parties)[number], role: "customer" | "supplier") => {
    const account = party.accounts.find((row) => row.role === role);
    return account ? (
      <Link
        key={role}
        to={`${base}/parties/${account.id}`}
        className="font-medium text-[var(--bo-fg)] tabular-nums hover:underline"
      >
        {account.code}
      </Link>
    ) : (
      ""
    );
  };
  return (
    <>
      <PageHeading
        eyebrow={books.name}
        title="Customers & suppliers"
        meta={`${books.parties.length} ${books.parties.length === 1 ? "party" : "parties"}`}
        actions={
          <FormDialog
            label="Add customer or supplier"
            variant="solid"
            title="Add a customer or supplier"
            description="A party can be both: add it again in its other role. Its open invoices and payments show on its page."
            intent={INTENT}
            resultIntent={INTENT}
            submit="Add"
            result={actionData}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Party">
                <Select
                  name="partyId"
                  options={[
                    { label: "A new party", value: "new" },
                    ...books.parties.map((party) => ({ label: party.name, value: party.id })),
                  ]}
                  value={partyId}
                  onValueChange={(value) => {
                    setPartyId(value ?? "new");
                  }}
                />
              </Field>
              {partyId === "new" ? (
                <Field label="Name">
                  <Input className="w-full" name="name" autoComplete="organization" required />
                </Field>
              ) : null}
            </div>
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <Field label="As">
                <Select
                  name="role"
                  options={[
                    { label: ROLE_LABELS.customer, value: "customer" },
                    { label: ROLE_LABELS.supplier, value: "supplier" },
                  ]}
                  defaultValue="customer"
                />
              </Field>
              <Field label="Code">
                <Input className="w-full" name="code" required />
              </Field>
            </div>
            <Field label="Control account">
              <Select
                name="controlAccountId"
                options={[
                  { label: "The usual one", value: "usual" },
                  ...controlAccounts.map((account) => ({
                    label: accountLabel(account),
                    value: account.id,
                  })),
                ]}
                defaultValue="usual"
              />
            </Field>
          </FormDialog>
        }
      />
      <SurfaceCard>
        {books.parties.length === 0 ? (
          <BackofficeSystemState
            flush
            tone="empty"
            label="Parties"
            title="No customers or suppliers yet"
            description="Add the businesses and people you invoice and pay. Their open invoices and payments show on their page."
          />
        ) : (
          <SurfaceTable columns={COLUMNS}>
            {books.parties.map((party) => (
              <SurfaceTableRow
                key={party.id}
                columns={COLUMNS}
                cells={[
                  <span key="name" className="font-medium text-[var(--bo-fg)]">
                    {party.name}
                  </span>,
                  roleCell(party, "customer"),
                  roleCell(party, "supplier"),
                ]}
              />
            ))}
          </SurfaceTable>
        )}
      </SurfaceCard>
    </>
  );
}
