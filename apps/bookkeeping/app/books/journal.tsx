import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Input } from "@fragno-private/design-system/input";
import { OverflowTabRow } from "@fragno-private/design-system/overflow-tab-row";
import {
  SurfacePanel,
  SurfacePanelFooter,
  SurfaceTable,
  SurfaceTableRow,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Form, Link, redirect, useNavigation, useOutletContext } from "react-router";
import { z } from "zod";

import { formatAmount } from "../../workers/books/money";
import type { Route } from "./+types/journal";
import { accountLabel, indexBooks } from "./books";
import { formResult, parseForm, requireBooks, requireBooksSubmission } from "./books.server";
import { FormError } from "./forms";
import type { BooksOutletContext } from "./layout";

export function meta() {
  return [{ title: "Journal · Bookkeeping" }];
}

/** A journal's entries, newest first; `?journal=` picks it, else the books' first journal. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { books } = await requireBooks(request, params);
  const url = new URL(request.url);
  const { journals } = await books.describe();
  const journal = journals.find((row) => row.id === url.searchParams.get("journal")) ?? journals[0];
  if (!journal) {
    return { journalId: null, entries: { items: [], cursor: null }, paged: false };
  }
  const cursor = url.searchParams.get("cursor");
  return {
    journalId: journal.id,
    entries: await books.listEntries({ journalId: journal.id, cursor }),
    paged: cursor !== null,
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

const reverseSchema = z.object({
  intent: z.literal("reverse"),
  entryId: z.string().min(1),
  postingDate: z.iso.date("Choose the date to reverse the entry on."),
});

/** Reverses an entry: posts its lines again, sides swapped, on the date chosen. */
export async function action({ request, params }: Route.ActionArgs) {
  const { user, books } = await requireBooksSubmission(request, params, "keep");
  const parsed = await parseForm(request, reverseSchema);
  if ("refusal" in parsed) {
    return parsed.refusal;
  }
  const { entryId, postingDate } = parsed.data;
  const outcome = await books.reverseEntry({
    entryId,
    postingDate,
    description: "Reversal",
    postedBy: user.name,
  });
  if (!outcome.ok) {
    return formResult(parsed.resultIntent, outcome);
  }
  // The reversal is the journal's newest entry: the first page shows it.
  const url = new URL(request.url);
  url.searchParams.delete("cursor");
  url.searchParams.delete("index");
  throw redirect(url.pathname + url.search);
}

const LINE_COLUMNS = [
  { label: "Account", align: "start" },
  { label: "Description", align: "start" },
  { label: "Debit", align: "end" },
  { label: "Credit", align: "end" },
] as const;

export default function JournalPage({ loaderData, actionData }: Route.ComponentProps) {
  const { books, base } = useOutletContext<BooksOutletContext>();
  const navigation = useNavigation();
  const { journalId, entries, paged } = loaderData;
  const index = indexBooks(books);
  const journal = journalId === null ? undefined : index.journals.get(journalId);
  if (!journal) {
    return (
      <BackofficeSystemState
        tone="empty"
        label="Journal"
        title="No journals yet"
        description="Add a journal in the books' settings to start posting entries."
      />
    );
  }
  const functionalDigits = index.minorUnitDigits(books.functionalCurrency);
  const journalPath = `${base}?journal=${journal.id}`;
  return (
    <div className="space-y-4">
      <OverflowTabRow
        ariaLabel="Journals"
        trailing={null}
        items={books.journals.map((row) => ({
          id: row.id,
          label: row.name,
          to: `${base}?journal=${row.id}`,
          active: row.id === journal.id,
        }))}
      />
      <SurfacePanel
        caption={`${journal.code} ${journal.name} · ${journal.lastEntryNumber} ${journal.lastEntryNumber === 1 ? "entry" : "entries"}`}
        actions={
          <ButtonLink variant="accent" to={`${base}/entries/new?journal=${journal.id}`}>
            New entry
          </ButtonLink>
        }
      >
        {entries.items.length === 0 ? (
          <BackofficeSystemState
            flush
            tone="empty"
            label={journal.name}
            title="No entries yet"
            description="Entries posted to this journal show here, newest first."
          />
        ) : null}
      </SurfacePanel>
      {entries.items.map((entry) => {
        const intent = `reverse-${entry.id}`;
        return (
          <SurfacePanel
            key={entry.id}
            caption={[
              `${journal.code} ${entry.entryNumber}`,
              entry.postingDate,
              ...(entry.reference === null ? [] : [entry.reference]),
              entry.description,
            ].join(" · ")}
            actions={
              entry.reverses ? (
                <span className="text-xs text-[var(--bo-muted)]">
                  Reverses {journal.code} {entry.reverses.entryNumber}
                </span>
              ) : entry.reversedBy ? (
                <span className="text-xs text-[var(--bo-muted)]">
                  Reversed by {journal.code} {entry.reversedBy.entryNumber}
                </span>
              ) : (
                <Form method="post" className="flex items-center gap-2">
                  <input type="hidden" name="intent" value="reverse" />
                  {/* Each entry has its own form. */}
                  <input type="hidden" name="resultIntent" value={intent} />
                  <input type="hidden" name="entryId" value={entry.id} />
                  <Input
                    density="compact"
                    type="date"
                    name="postingDate"
                    defaultValue={entry.postingDate}
                    aria-label={`Date to reverse ${journal.code} ${entry.entryNumber} on`}
                    required
                  />
                  <Button type="submit" variant="ghost" disabled={navigation.state !== "idle"}>
                    Reverse
                  </Button>
                </Form>
              )
            }
          >
            <SurfaceTable columns={LINE_COLUMNS}>
              {entry.lines.map((line) => {
                const account = index.accounts.get(line.accountId)!;
                const partyAccount =
                  line.openItem && index.partyAccounts.get(line.openItem.partyAccountId)!;
                const amount = formatAmount(line.functionalAmountMinor, functionalDigits);
                const foreign =
                  line.currency === books.functionalCurrency
                    ? null
                    : `${line.currency} ${formatAmount(line.amountMinor, index.minorUnitDigits(line.currency))}`;
                const dimensions = line.dimensionValueIds.map(
                  (valueId) => index.dimensionValues.get(valueId)!.name,
                );
                return (
                  <SurfaceTableRow
                    key={line.id}
                    columns={LINE_COLUMNS}
                    // Fixed widths line the columns of every entry's table up.
                    cells={[
                      <Link
                        key="account"
                        to={`${base}/accounts/${account.id}`}
                        className="inline-block w-56"
                      >
                        {accountLabel(account)}
                      </Link>,
                      [
                        line.description,
                        partyAccount && `${partyAccount.party.name} (${partyAccount.code})`,
                        foreign,
                        ...dimensions,
                      ]
                        .filter((part) => part !== null && part !== "")
                        .join(" · "),
                      <span key="debit" className="inline-block w-24">
                        {line.side === "debit" ? amount : ""}
                      </span>,
                      <span key="credit" className="inline-block w-24">
                        {line.side === "credit" ? amount : ""}
                      </span>,
                    ]}
                  />
                );
              })}
            </SurfaceTable>
            <SurfacePanelFooter>
              <span className="mr-auto text-xs text-[var(--bo-muted)]">
                Posted by {entry.postedBy}
              </span>
              <FormError result={actionData} intent={intent} />
            </SurfacePanelFooter>
          </SurfacePanel>
        );
      })}
      {entries.cursor !== null || paged ? (
        <div className="flex justify-end gap-2">
          {paged ? (
            <ButtonLink variant="ghost" to={journalPath}>
              Newest entries
            </ButtonLink>
          ) : null}
          {entries.cursor !== null ? (
            <ButtonLink variant="secondary" to={`${journalPath}&cursor=${entries.cursor}`}>
              Older entries
            </ButtonLink>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
