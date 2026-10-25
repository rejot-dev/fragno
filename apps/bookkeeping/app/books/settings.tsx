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
import type { ReactNode } from "react";
import { Form, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import {
  dayAfter,
  PERIOD_LENGTHS,
  periodEndDates,
  type PeriodLength,
} from "../../workers/books/fiscal-years";
import type { Route } from "./+types/settings";
import { formResult, parseForm, requireBooksSubmission, type FormResult } from "./books.server";
import { FormError, useFormReset } from "./forms";
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

const PERIOD_COLUMNS = [
  { label: "Period", align: "start" },
  { label: "From", align: "start" },
  { label: "Through", align: "start" },
  { label: "Status", align: "start" },
  { label: "", align: "end" },
] as const;

const JOURNAL_COLUMNS = [
  { label: "Code", align: "start" },
  { label: "Name", align: "start" },
  { label: "Entries", align: "end" },
] as const;

const VALUE_COLUMNS = [
  { label: "Code", align: "start" },
  { label: "Name", align: "start" },
] as const;

const STATUS_LABELS = { open: "Open", closed: "Closed", locked: "Locked" } as const;

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

  return (
    <div className="space-y-6">
      {canSetUp ? null : (
        <p className="text-sm text-[var(--bo-muted)]">
          Owners and admins of this workspace set the books up.
        </p>
      )}
      {books.fiscalYears.map((year) => (
        <SurfacePanel
          key={year.id}
          caption={`Fiscal year ${year.name} · ${year.startDate} through ${year.endDate}`}
          actions={null}
        >
          <SurfaceTable columns={PERIOD_COLUMNS}>
            {year.periods.map((period) => (
              <SurfaceTableRow
                key={period.id}
                columns={PERIOD_COLUMNS}
                cells={[
                  `Period ${period.number}`,
                  period.startDate,
                  period.endDate,
                  STATUS_LABELS[period.status],
                  canSetUp ? (
                    <span key="actions" className="inline-flex gap-1">
                      {TRANSITIONS[period.status].map(({ transition, label }) => (
                        <Form key={transition} method="post">
                          <input type="hidden" name="intent" value="transition-period" />
                          <input type="hidden" name="periodId" value={period.id} />
                          <input type="hidden" name="transition" value={transition} />
                          <Button
                            type="submit"
                            variant={transition === "lock" ? "danger" : "ghost"}
                            disabled={busy}
                            aria-label={`${label} period ${period.number} of ${year.name}`}
                          >
                            {label}
                          </Button>
                        </Form>
                      ))}
                    </span>
                  ) : (
                    ""
                  ),
                ]}
              />
            ))}
          </SurfaceTable>
        </SurfacePanel>
      ))}
      <FormError result={actionData} intent="transition-period" />
      {canSetUp ? (
        <SettingsForm
          intent="open-fiscal-year"
          title={
            nextStart ? `Open the fiscal year starting ${nextStart}` : "Open the first fiscal year"
          }
          submit="Open fiscal year"
          result={actionData}
        >
          <div className="grid gap-4 sm:grid-cols-3">
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
        </SettingsForm>
      ) : null}

      <SurfacePanel caption={`Journals · ${books.journals.length}`} actions={null}>
        <SurfaceTable columns={JOURNAL_COLUMNS}>
          {books.journals.map((journal) => (
            <SurfaceTableRow
              key={journal.id}
              columns={JOURNAL_COLUMNS}
              cells={[journal.code, journal.name, String(journal.lastEntryNumber)]}
            />
          ))}
        </SurfaceTable>
      </SurfacePanel>
      {canSetUp ? (
        <SettingsForm
          intent="create-journal"
          title="New journal"
          submit="Add journal"
          result={actionData}
        >
          <CodeAndName />
        </SettingsForm>
      ) : null}

      {books.dimensions.map((dimension) => (
        <SurfacePanel
          key={dimension.id}
          caption={`Dimension ${dimension.code} · ${dimension.name}`}
          actions={null}
        >
          <SurfaceTable columns={VALUE_COLUMNS}>
            {dimension.values.map((value) => (
              <SurfaceTableRow
                key={value.id}
                columns={VALUE_COLUMNS}
                cells={[value.code, value.name]}
              />
            ))}
          </SurfaceTable>
          {canSetUp ? (
            <SurfacePanelBody>
              <IntentForm
                intent="create-dimension-value"
                resultIntent={`create-dimension-value-${dimension.id}`}
                submit={`Add to ${dimension.name}`}
                result={actionData}
              >
                <input type="hidden" name="dimensionId" value={dimension.id} />
                <CodeAndName />
              </IntentForm>
            </SurfacePanelBody>
          ) : null}
        </SurfacePanel>
      ))}
      {canSetUp ? (
        <SettingsForm
          intent="create-dimension"
          title="New dimension"
          description="Dimensions, such as cost centres or projects, tag lines to report on them. Accounts can require or refuse each one."
          submit="Add dimension"
          result={actionData}
        >
          <CodeAndName />
        </SettingsForm>
      ) : null}

      <SurfacePanel
        caption={`Currencies · ${books.currencies.map((row) => row.code).join(", ")}`}
        actions={null}
      >
        {canSetUp ? (
          <SurfacePanelBody>
            <IntentForm
              intent="add-currency"
              resultIntent="add-currency"
              submit="Add currency"
              result={actionData}
            >
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
            </IntentForm>
          </SurfacePanelBody>
        ) : null}
      </SurfacePanel>
    </div>
  );
}

function CodeAndName() {
  return (
    <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
      <Field label="Code">
        <Input className="w-full" name="code" required />
      </Field>
      <Field label="Name">
        <Input className="w-full" name="name" required />
      </Field>
    </div>
  );
}

/** A settings form in its own panel. */
function SettingsForm({
  intent,
  title,
  description,
  submit,
  result,
  children,
}: {
  intent: string;
  title: string;
  description?: string;
  submit: string;
  result: FormResult | undefined;
  children: ReactNode;
}) {
  return (
    <SurfacePanel caption={title} actions={null}>
      <SurfacePanelBody>
        {description ? (
          <p className="mb-4 max-w-2xl text-sm text-[var(--bo-muted)]">{description}</p>
        ) : null}
        <IntentForm intent={intent} resultIntent={intent} submit={submit} result={result}>
          {children}
        </IntentForm>
      </SurfacePanelBody>
    </SurfacePanel>
  );
}

/** A form submitting `intent`, showing the refusal answered for `resultIntent` and emptied once it succeeds. */
function IntentForm({
  intent,
  resultIntent,
  submit,
  result,
  children,
}: {
  intent: string;
  resultIntent: string;
  submit: string;
  result: FormResult | undefined;
  children: ReactNode;
}) {
  const navigation = useNavigation();
  const form = useFormReset(result, resultIntent);
  return (
    <Form method="post" ref={form} className="max-w-2xl space-y-4">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="resultIntent" value={resultIntent} />
      {children}
      <FormError result={result} intent={resultIntent} />
      <Button type="submit" variant="accent" disabled={navigation.state !== "idle"}>
        {submit}
      </Button>
    </Form>
  );
}
