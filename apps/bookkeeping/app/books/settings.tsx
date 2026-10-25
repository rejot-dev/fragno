import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { Select } from "@fragno-private/design-system/select";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfaceSection,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/surface-panel";
import type { ComponentProps } from "react";
import { Form, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import {
  dayAfter,
  PERIOD_LENGTHS,
  periodEndDates,
  type PeriodLength,
} from "../../workers/books/fiscal-years";
import type { Route } from "./+types/settings";
import { formatDate, formatDateRange, monthOf } from "./books";
import { formResult, parseForm, requireBooksSubmission, type FormResult } from "./books.server";
import { FormDialog, FormError } from "./forms";
import type { BooksOutletContext } from "./layout";

export function meta() {
  return [{ title: "Settings · Bookkeeping" }];
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const code = (what: string) =>
  z.string().trim().min(1, `Enter the ${what}'s code.`).max(20, "Use at most 20 characters.");
const name = (what: string) =>
  z.string().trim().min(1, `Enter the ${what}'s name.`).max(160, "Use at most 160 characters.");

const settingsSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("open-fiscal-year"),
    name: name("fiscal year"),
    // Only the first fiscal year chooses where it starts; later ones follow the last.
    startDate: z.union([z.literal(""), z.iso.date("Enter the date the fiscal year starts.")]),
    periodLength: z.enum(Object.keys(PERIOD_LENGTHS) as PeriodLength[]),
  }),
  z.object({
    intent: z.literal("transition-period"),
    periodId: z.string().min(1),
    transition: z.enum(["close", "reopen", "lock"]),
  }),
  z.object({ intent: z.literal("create-journal"), code: code("journal"), name: name("journal") }),
  z.object({
    intent: z.literal("create-dimension"),
    code: code("dimension"),
    name: name("dimension"),
  }),
  z.object({
    intent: z.literal("create-dimension-value"),
    dimensionId: z.string().min(1),
    code: code("value"),
    name: name("value"),
  }),
  z.object({
    intent: z.literal("add-currency"),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/u, "Enter the currency's three-letter ISO code, like USD."),
    minorUnitDigits: z.coerce
      .number()
      .int()
      .min(0, "Enter the number of decimals, from 0 to 4.")
      .max(4, "Enter the number of decimals, from 0 to 4."),
  }),
]);

/** Sets the books up: their calendar, journals, dimensions, and currencies. */
export async function action({ request, params }: Route.ActionArgs): Promise<FormResult> {
  const { books } = await requireBooksSubmission(request, params, "set-up");
  const parsed = await parseForm(request, settingsSchema);
  if ("refusal" in parsed) {
    return parsed.refusal;
  }
  const submitted = parsed.data;
  if (submitted.intent === "open-fiscal-year") {
    const last = (await books.describe()).fiscalYears.at(-1);
    const startDate = last ? dayAfter(last.endDate) : submitted.startDate;
    if (startDate === "") {
      return { intent: submitted.intent, error: "Enter the date the fiscal year starts." };
    }
    return formResult(
      submitted.intent,
      await books.openFiscalYear({
        name: submitted.name,
        startDate,
        periodEndDates: periodEndDates(startDate, submitted.periodLength),
      }),
    );
  }
  if (submitted.intent === "transition-period") {
    return formResult(
      submitted.intent,
      await books.transitionPeriod({
        periodId: submitted.periodId,
        transition: submitted.transition,
      }),
    );
  }
  if (submitted.intent === "create-journal") {
    return formResult(
      submitted.intent,
      await books.createJournal({ code: submitted.code, name: submitted.name }),
    );
  }
  if (submitted.intent === "create-dimension") {
    return formResult(
      submitted.intent,
      await books.createDimension({ code: submitted.code, name: submitted.name }),
    );
  }
  if (submitted.intent === "create-dimension-value") {
    return formResult(
      parsed.resultIntent,
      await books.createDimensionValue({
        dimensionId: submitted.dimensionId,
        code: submitted.code,
        name: submitted.name,
      }),
    );
  }
  return formResult(
    submitted.intent,
    await books.addCurrency({ code: submitted.code, minorUnitDigits: submitted.minorUnitDigits }),
  );
}

const JOURNAL_COLUMNS = [
  { label: "Code", align: "start" },
  { label: "Name", align: "start" },
  { label: "Entries", align: "end" },
] as const;

const DIMENSION_COLUMNS = [
  { label: "Dimension", align: "start" },
  { label: "Values", align: "start" },
  { label: "", align: "end" },
] as const;

const CURRENCY_COLUMNS = [
  { label: "Code", align: "start" },
  { label: "Decimals", align: "end" },
  { label: "", align: "end" },
] as const;

const STATUSES = {
  open: { label: "Open", tone: "live" },
  closed: { label: "Closed", tone: "waiting" },
  locked: { label: "Locked", tone: "muted" },
} as const;

/** What can happen to a period next: closed periods reopen for corrections or lock for good. */
const TRANSITIONS = {
  open: [{ transition: "close", label: "Close" }],
  closed: [
    { transition: "reopen", label: "Reopen" },
    { transition: "lock", label: "Lock" },
  ],
  locked: [],
} as const;

const PERIOD_LENGTH_OPTIONS: { label: string; value: PeriodLength }[] = [
  { label: "Twelve months", value: "month" },
  { label: "Four quarters", value: "quarter" },
  { label: "One period", value: "year" },
];

export default function SettingsPage({ actionData }: Route.ComponentProps) {
  const { books, canSetUp } = useOutletContext<BooksOutletContext>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const lastYear = books.fiscalYears.at(-1);
  const nextStart = lastYear ? dayAfter(lastYear.endDate) : null;
  const dialog = (props: Omit<ComponentProps<typeof FormDialog>, "result" | "variant">) =>
    canSetUp ? <FormDialog variant="secondary" result={actionData} {...props} /> : null;

  return (
    <>
      <PageHeading
        eyebrow={books.name}
        title="Settings"
        meta={canSetUp ? null : "Owners and admins of this workspace set the books up."}
        actions={null}
      />
      <SurfaceSection
        title="Fiscal years"
        meta="Periods move from open to closed, and closed ones reopen or lock for good."
        actions={dialog({
          label: "Open fiscal year",
          title: nextStart
            ? `Open the fiscal year starting ${formatDate(nextStart)}`
            : "Open the first fiscal year",
          description: null,
          intent: "open-fiscal-year",
          resultIntent: "open-fiscal-year",
          submit: "Open fiscal year",
          children: (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input
                  className="w-full"
                  name="name"
                  defaultValue={nextStart?.slice(0, 4) ?? ""}
                  required
                />
              </Field>
              {nextStart === null ? (
                <Field label="Starts">
                  <Input className="w-full" type="date" name="startDate" required />
                </Field>
              ) : (
                <input type="hidden" name="startDate" value="" />
              )}
              <Field label="Periods">
                <Select name="periodLength" options={PERIOD_LENGTH_OPTIONS} defaultValue="month" />
              </Field>
            </div>
          ),
        })}
      >
        <div className="space-y-5 border-t border-[color:var(--bo-border)] p-4">
          {books.fiscalYears.map((year) => (
            <div key={year.id} className="space-y-2">
              <h3 className="text-sm font-semibold text-[var(--bo-fg)]">
                {year.name}
                <span className="ml-2 font-normal text-[var(--bo-muted)] tabular-nums">
                  {formatDateRange(year.startDate, year.endDate)}
                </span>
              </h3>
              <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-6">
                {year.periods.map((period) => {
                  const monthly = period.startDate.slice(0, 7) === period.endDate.slice(0, 7);
                  const status = STATUSES[period.status];
                  return (
                    <li
                      key={period.id}
                      className="flex min-h-11 items-center gap-2 rounded-[4px] border border-[color:var(--bo-border)] py-1 pr-1 pl-3"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-[var(--bo-fg)]">
                          {monthly ? monthOf(period.startDate) : `Period ${period.number}`}
                        </span>
                        {monthly ? null : (
                          <span className="block text-xs text-[var(--bo-muted)] tabular-nums">
                            {formatDateRange(period.startDate, period.endDate)}
                          </span>
                        )}
                      </span>
                      <span
                        className="bo-status-tone inline-flex items-center gap-1.5 text-xs text-[var(--bo-muted)]"
                        data-tone={status.tone}
                      >
                        <span
                          className="bo-status-light-dot size-1.5 text-[var(--bo-status-color)]"
                          aria-hidden="true"
                        />
                        {status.label}
                      </span>
                      {canSetUp ? (
                        <span className="ml-auto flex">
                          {TRANSITIONS[period.status].map(({ transition, label }) => (
                            <Form key={transition} method="post">
                              <input type="hidden" name="intent" value="transition-period" />
                              <input type="hidden" name="periodId" value={period.id} />
                              <input type="hidden" name="transition" value={transition} />
                              <Button
                                type="submit"
                                variant={transition === "lock" ? "danger" : "ghost"}
                                className="min-h-8 px-2 text-xs"
                                disabled={busy}
                                aria-label={`${label} period ${period.number} of ${year.name}`}
                              >
                                {label}
                              </Button>
                            </Form>
                          ))}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
          <FormError result={actionData} intent="transition-period" />
        </div>
      </SurfaceSection>

      <SurfaceSection
        title="Journals"
        meta="Each numbers its entries without gaps."
        actions={dialog({
          label: "New journal",
          title: "New journal",
          description: null,
          intent: "create-journal",
          resultIntent: "create-journal",
          submit: "Add journal",
          children: <CodeAndName />,
        })}
      >
        <SurfaceTable columns={JOURNAL_COLUMNS}>
          {books.journals.map((journal) => (
            <SurfaceTableRow
              key={journal.id}
              columns={JOURNAL_COLUMNS}
              cells={[
                <span key="code" className="font-medium text-[var(--bo-fg)] tabular-nums">
                  {journal.code}
                </span>,
                journal.name,
                String(journal.lastEntryNumber),
              ]}
            />
          ))}
        </SurfaceTable>
      </SurfaceSection>

      <SurfaceSection
        title="Dimensions"
        meta="Tag lines to report on them, such as cost centres or projects."
        actions={dialog({
          label: "New dimension",
          title: "New dimension",
          description: "Accounts can require or refuse each dimension.",
          intent: "create-dimension",
          resultIntent: "create-dimension",
          submit: "Add dimension",
          children: <CodeAndName />,
        })}
      >
        {books.dimensions.length === 0 ? (
          <p className="border-t border-[color:var(--bo-border)] px-4 py-3 text-sm text-[var(--bo-muted)]">
            No dimensions yet.
          </p>
        ) : (
          <SurfaceTable columns={DIMENSION_COLUMNS}>
            {books.dimensions.map((dimension) => (
              <SurfaceTableRow
                key={dimension.id}
                columns={DIMENSION_COLUMNS}
                cells={[
                  <span key="name" className="whitespace-nowrap text-[var(--bo-fg)]">
                    <span className="mr-2 text-[var(--bo-muted-2)] tabular-nums">
                      {dimension.code}
                    </span>
                    {dimension.name}
                  </span>,
                  <span key="values" className="inline-flex flex-wrap gap-1.5">
                    {dimension.values.length === 0
                      ? "No values yet"
                      : dimension.values.map((value) => (
                          <BackofficeStatusLight key={value.id} tone="info" dot={false}>
                            {value.code} · {value.name}
                          </BackofficeStatusLight>
                        ))}
                  </span>,
                  dialog({
                    label: "Add value",
                    title: `Add a value to ${dimension.name}`,
                    description: null,
                    intent: "create-dimension-value",
                    // Each dimension has its own form, which its refusals show under.
                    resultIntent: `create-dimension-value-${dimension.id}`,
                    submit: "Add value",
                    children: (
                      <>
                        <input type="hidden" name="dimensionId" value={dimension.id} />
                        <CodeAndName />
                      </>
                    ),
                  }),
                ]}
              />
            ))}
          </SurfaceTable>
        )}
      </SurfaceSection>

      <SurfaceSection
        title="Currencies"
        meta={`Amounts are kept in ${books.functionalCurrency}; lines in other currencies carry both.`}
        actions={dialog({
          label: "Add currency",
          title: "Add a currency",
          description: null,
          intent: "add-currency",
          resultIntent: "add-currency",
          submit: "Add currency",
          children: (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="ISO code">
                <Input className="w-full" name="code" maxLength={3} required />
              </Field>
              <Field label="Decimals">
                <Input
                  className="w-full"
                  name="minorUnitDigits"
                  type="number"
                  min={0}
                  max={4}
                  defaultValue={2}
                  required
                />
              </Field>
            </div>
          ),
        })}
      >
        <SurfaceTable columns={CURRENCY_COLUMNS}>
          {books.currencies.map((currency) => (
            <SurfaceTableRow
              key={currency.code}
              columns={CURRENCY_COLUMNS}
              cells={[
                <span key="code" className="font-medium text-[var(--bo-fg)]">
                  {currency.code}
                </span>,
                String(currency.minorUnitDigits),
                currency.code === books.functionalCurrency ? (
                  <BackofficeStatusLight key="functional" tone="info" dot={false}>
                    Books kept in it
                  </BackofficeStatusLight>
                ) : (
                  ""
                ),
              ]}
            />
          ))}
        </SurfaceTable>
      </SurfaceSection>
    </>
  );
}

function CodeAndName() {
  return (
    <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
      <Field label="Code">
        <Input className="w-full" name="code" required />
      </Field>
      <Field label="Name">
        <Input className="w-full" name="name" required />
      </Field>
    </div>
  );
}
