import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import {
  SurfaceCard,
  SurfaceFacts,
  SurfaceSection,
  SurfaceTable,
  SurfaceTableRow,
  SurfaceTableTotalRow,
} from "@fragno-private/design-system/surface-panel";
import { Link, redirect, useOutletContext } from "react-router";
import { z } from "zod";

import { today } from "../../workers/books/fiscal-years";
import { formatAmount } from "../../workers/books/money";
import type { Route } from "./+types/entry";
import { booksPath, entryPath, formatDate, indexBooks } from "./books";
import { formResult, parseForm, requireBooks, requireBooksSubmission } from "./books.server";
import { LINE_COLUMNS, lineCells } from "./entry-lines";
import { FormDialog } from "./forms";
import type { BooksOutletContext } from "./layout";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params.journal} ${params.entryNumber} · Bookkeeping` }];
}

/** The books and the entry named by its journal's code and its number in that journal. */
async function requireEntry(
  context: Awaited<ReturnType<typeof requireBooks>>,
  params: Route.LoaderArgs["params"],
) {
  const { journals } = await context.books.describe();
  const journal = journals.find((row) => row.code === params.journal);
  const entryNumber = Number(params.entryNumber);
  const entry =
    journal && Number.isSafeInteger(entryNumber)
      ? await context.books.getEntry({ journalId: journal.id, entryNumber })
      : null;
  if (!journal || !entry) {
    throw new Response("This entry does not exist.", { status: 404 });
  }
  return { journal, entry };
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { journal, entry } = await requireEntry(await requireBooks(request, params), params);
  return { journalId: journal.id, entry, today: today() };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const REVERSE = "reverse";

const reverseSchema = z.object({
  intent: z.literal(REVERSE),
  postingDate: z.iso.date("Choose the date to reverse the entry on."),
});

/** Reverses the entry: posts its lines again, sides swapped, on the date chosen; then shows the reversal. */
export async function action({ request, params }: Route.ActionArgs) {
  const context = await requireBooksSubmission(request, params, "keep");
  const { journal, entry } = await requireEntry(context, params);
  const parsed = await parseForm(request, reverseSchema);
  if ("refusal" in parsed) {
    return parsed.refusal;
  }
  const outcome = await context.books.reverseEntry({
    entryId: entry.id,
    postingDate: parsed.data.postingDate,
    description: `Reversal of ${journal.code} ${entry.entryNumber}`,
    postedBy: context.user.name,
  });
  if (!outcome.ok) {
    return formResult(REVERSE, outcome);
  }
  throw redirect(entryPath(booksPath(params), journal.code, outcome.value.entryNumber));
}

export default function EntryPage({ loaderData, actionData }: Route.ComponentProps) {
  const context = useOutletContext<BooksOutletContext>();
  const { books, base } = context;
  const { entry } = loaderData;
  const index = indexBooks(books);
  const journal = index.journals.get(loaderData.journalId)!;
  const digits = index.minorUnitDigits(books.functionalCurrency);
  const total = entry.lines
    .filter((line) => line.side === "debit")
    .reduce((sum, line) => sum + line.functionalAmountMinor, 0n);
  const relatedEntry = (label: string, related: { entryNumber: number }) => (
    <Link to={entryPath(base, journal.code, related.entryNumber)} className="hover:underline">
      {label} {journal.code} {related.entryNumber}
    </Link>
  );
  return (
    <>
      <PageHeading
        eyebrow={
          <Link to={`${base}?journal=${journal.id}`} className="hover:underline">
            {journal.name} journal
          </Link>
        }
        title={`${journal.code} ${entry.entryNumber} · ${entry.description}`}
        meta={null}
        actions={
          entry.reversedBy ? null : (
            <FormDialog
              label="Reverse entry"
              variant="secondary"
              title={`Reverse ${journal.code} ${entry.entryNumber}`}
              description="Posts every line again with its side swapped, in this journal. The entry stays as it was posted; customers' and suppliers' open items it made are settled by the reversal."
              intent={REVERSE}
              resultIntent={REVERSE}
              submit="Reverse entry"
              result={actionData}
            >
              <Field label="Reverse on">
                <Input
                  className="w-full"
                  type="date"
                  name="postingDate"
                  defaultValue={loaderData.today}
                  required
                />
              </Field>
            </FormDialog>
          )
        }
      />
      <SurfaceCard>
        <SurfaceFacts
          items={[
            { key: "date", label: "Date", value: formatDate(entry.postingDate) },
            { key: "reference", label: "Reference", value: entry.reference ?? "None" },
            { key: "posted", label: "Posted by", value: entry.postedBy },
            {
              key: "status",
              label: "Status",
              value: entry.reversedBy
                ? relatedEntry("Reversed by", entry.reversedBy)
                : entry.reverses
                  ? relatedEntry("Reverses", entry.reverses)
                  : "Posted",
            },
          ]}
        />
      </SurfaceCard>
      <SurfaceSection
        title="Lines"
        meta={`${entry.lines.length} lines in ${books.functionalCurrency}`}
        actions={null}
      >
        <SurfaceTable columns={LINE_COLUMNS}>
          {entry.lines.map((line) => (
            <SurfaceTableRow
              key={line.id}
              columns={LINE_COLUMNS}
              cells={lineCells(line, context, index)}
            />
          ))}
          <SurfaceTableTotalRow
            columns={LINE_COLUMNS}
            cells={["Total", "", formatAmount(total, digits), formatAmount(total, digits)]}
          />
        </SurfaceTable>
      </SurfaceSection>
    </>
  );
}
