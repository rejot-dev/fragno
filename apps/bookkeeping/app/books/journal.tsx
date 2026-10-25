import { ButtonLink } from "@fragno-private/design-system/button";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { Select } from "@fragno-private/design-system/select";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfaceCard,
  SurfacePanelFooter,
  SurfaceTable,
  SurfaceTableGroupRow,
  SurfaceTableRow,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Fragment } from "react";
import { Link, useNavigate, useOutletContext } from "react-router";

import type { Route } from "./+types/journal";
import { entryPath, formatDate, indexBooks } from "./books";
import { requireBooks } from "./books.server";
import { LINE_COLUMNS, lineCells } from "./entry-lines";
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

export default function JournalPage({ loaderData }: Route.ComponentProps) {
  const context = useOutletContext<BooksOutletContext>();
  const { books, base } = context;
  const navigate = useNavigate();
  const { journalId, entries, paged } = loaderData;
  const index = indexBooks(books);
  const journal = journalId === null ? undefined : index.journals.get(journalId);
  if (!journal) {
    return (
      <>
        <PageHeading eyebrow={books.name} title="Journal" meta={null} actions={null} />
        <BackofficeSystemState
          tone="empty"
          label="Journal"
          title="No journals yet"
          description="Add a journal in the books' settings to start posting entries."
        />
      </>
    );
  }
  const journalPath = `${base}?journal=${journal.id}`;
  const count = journal.lastEntryNumber;
  return (
    <>
      <PageHeading
        eyebrow={books.name}
        title={`${journal.name} journal`}
        meta={`${count} ${count === 1 ? "entry" : "entries"} · amounts in ${books.functionalCurrency}`}
        actions={
          <>
            <div className="w-48">
              <Select
                aria-label="Journal"
                options={books.journals.map((row) => ({
                  label: `${row.code} · ${row.name}`,
                  value: row.id,
                }))}
                value={journal.id}
                onValueChange={(id) => {
                  if (id !== null && id !== journal.id) {
                    void navigate(`${base}?journal=${id}`);
                  }
                }}
              />
            </div>
            <ButtonLink variant="solid" to={`${base}/entries/new?journal=${journal.id}`}>
              New entry
            </ButtonLink>
          </>
        }
      />
      <SurfaceCard>
        {entries.items.length === 0 ? (
          <BackofficeSystemState
            flush
            tone="empty"
            label={journal.name}
            title="No entries yet"
            description="Entries posted to this journal show here, newest first."
          />
        ) : (
          <SurfaceTable columns={LINE_COLUMNS}>
            {entries.items.map((entry) => (
              <Fragment key={entry.id}>
                <SurfaceTableGroupRow columns={LINE_COLUMNS}>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <Link
                      to={entryPath(base, journal.code, entry.entryNumber)}
                      className="font-semibold tabular-nums hover:underline"
                    >
                      {journal.code} {entry.entryNumber}
                    </Link>
                    <span className="text-[var(--bo-muted)] tabular-nums">
                      {formatDate(entry.postingDate)}
                    </span>
                    <span className="min-w-0 font-medium">{entry.description}</span>
                    {entry.reference === null ? null : (
                      <span className="text-[var(--bo-muted)]">Ref. {entry.reference}</span>
                    )}
                    <span className="ml-auto flex items-center gap-3">
                      {entry.reverses ? (
                        <BackofficeStatusLight tone="muted">
                          Reverses {journal.code} {entry.reverses.entryNumber}
                        </BackofficeStatusLight>
                      ) : null}
                      {entry.reversedBy ? (
                        <BackofficeStatusLight tone="waiting">
                          Reversed by {journal.code} {entry.reversedBy.entryNumber}
                        </BackofficeStatusLight>
                      ) : null}
                      <span className="text-xs text-[var(--bo-muted-2)]">{entry.postedBy}</span>
                    </span>
                  </div>
                </SurfaceTableGroupRow>
                {entry.lines.map((line) => (
                  <SurfaceTableRow
                    key={line.id}
                    columns={LINE_COLUMNS}
                    cells={lineCells(line, context, index)}
                  />
                ))}
              </Fragment>
            ))}
          </SurfaceTable>
        )}
        {entries.cursor !== null || paged ? (
          <SurfacePanelFooter>
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
          </SurfacePanelFooter>
        ) : null}
      </SurfaceCard>
    </>
  );
}
