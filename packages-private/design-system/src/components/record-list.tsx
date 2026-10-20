import { BackofficeStatusLight, type BackofficeStatusTone } from "./status-light";

export type RecordListItem = {
  key: string;
  title: string;
  detail?: string;
  /** Shown as a status light beside the title. */
  status?: string;
  tone: BackofficeStatusTone;
};

/** Operational records, such as recent deliveries, each with an optional status. */
export function RecordList({
  items,
  totalCount = items.length,
}: {
  items: readonly RecordListItem[];
  /** When the items are the first of a larger set, the size of that set. */
  totalCount?: number;
}) {
  return (
    <div className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <ul className="divide-y divide-[color:var(--bo-border)]">
        {items.map((item) => (
          <li key={item.key} className="flex min-w-0 items-start gap-3 p-3">
            <span
              data-tone={item.tone}
              className="bo-status-tone mt-2 size-1.5 shrink-0 bg-[var(--bo-status-color)]"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-xs leading-5 font-semibold text-[var(--bo-fg)]">{item.title}</p>
                {item.status ? (
                  <BackofficeStatusLight tone={item.tone} dot={false}>
                    {item.status}
                  </BackofficeStatusLight>
                ) : null}
              </div>
              {item.detail ? (
                <p className="mt-1 text-[11px] leading-5 text-[var(--bo-muted)]">{item.detail}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {totalCount > items.length ? (
        <p
          role="status"
          className="border-t border-[color:var(--bo-border)] px-3 py-2 text-[10px] text-[var(--bo-muted-2)]"
        >
          Showing the first {items.length} of {totalCount} items.
        </p>
      ) : null}
    </div>
  );
}
