import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";

import { Icon, type IconName } from "./icon";
import type { BackofficeStatusTone } from "./status-tone";

/**
 * Rows divided by rules, as a panel lists connections, agents, or what needs attention. Rows can
 * arrive after render, such as a live query's, so a list without rows hides itself by CSS and
 * shows `empty` in its place. Lists that follow one another read as one, divided by a rule too.
 */
export function RowList({ empty, children }: { empty: ReactNode; children: ReactNode }) {
  return (
    <>
      <ul className="divide-y divide-[color:var(--bo-border)] empty:hidden [ul:not(:empty)~&]:border-t [ul:not(:empty)~&]:border-[color:var(--bo-border)]">
        {children}
      </ul>
      {empty === null ? null : (
        <p className="hidden py-5 text-sm text-pretty text-[var(--bo-muted)] [ul:empty+&]:block">
          {empty}
        </p>
      )}
    </>
  );
}

const rowClassName = "group flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5";

/** What an expandable row shows below itself once opened, and the toggle that opens it. */
export type ListRowExpansion = { label: string; content: ReactNode };

/**
 * One row of a RowList: what it is, a line about it, and what it trails with, such as a time or a
 * status. With `to`, the whole row leads there, so its trailing content holds no links; while that
 * page is open, as when the row's record shows beside its list, the row reads as selected. With an
 * expansion, the row opens to show its content below, such as a form to answer; then only the
 * title leads to `to`, so the rest of the row toggles, and its trailing content can hold controls,
 * such as links or buttons, which act without toggling.
 */
export function ListRow({
  leading,
  title,
  detail,
  trailing,
  to,
  expansion,
}: {
  leading: ReactNode;
  title: string;
  detail: ReactNode;
  trailing: ReactNode;
  to: string | null;
  expansion: ListRowExpansion | null;
}) {
  const titleClassName = "block truncate text-sm font-semibold text-[var(--bo-fg)]";
  const content = (titleElement: ReactNode, end: ReactNode) => (
    <>
      {leading}
      {/* In a narrow column the trailing content wraps under the title rather than truncating
          it to a few letters. */}
      <span className="min-w-[min(100%,12rem)] flex-1">
        {titleElement}
        {detail === null ? null : (
          <span className="block truncate text-xs text-[var(--bo-muted-2)]">{detail}</span>
        )}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-3 text-xs">
        {trailing}
        {end}
      </span>
    </>
  );

  if (expansion !== null) {
    return (
      <li>
        <details className="group/expansion">
          <summary
            className={`${rowClassName} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
          >
            {content(
              to === null ? (
                <span className={titleClassName} title={title}>
                  {title}
                </span>
              ) : (
                <Link to={to} className={`${titleClassName} hover:underline`} title={title}>
                  {title}
                </Link>
              ),
              <span className="inline-flex items-center gap-1 font-semibold text-[var(--bo-accent-fg)]">
                {expansion.label}
                <Icon
                  name="chevron-down"
                  className="size-3.5 transition-transform group-open/expansion:rotate-180"
                />
              </span>,
            )}
          </summary>
          {/* Lines up with the title past a leading tile. */}
          <div className={`pb-3 ${leading === null ? "" : "pl-11"}`}>{expansion.content}</div>
        </details>
      </li>
    );
  }

  const row = content(
    <span
      className={`${titleClassName} ${to === null ? "" : "group-hover:underline group-aria-[current=page]:text-[var(--bo-accent-fg)]"}`}
      title={title}
    >
      {title}
    </span>,
    null,
  );
  return (
    <li>
      {to === null ? (
        <div className={rowClassName}>{row}</div>
      ) : (
        <NavLink to={to} end className={rowClassName}>
          {row}
        </NavLink>
      )}
    </li>
  );
}

/**
 * What kind of row a ListRow is. A tone sets the icon on a tile in that tone, for rows that ask
 * for something, such as a failure; without one, the icon stays muted.
 */
export function ListRowIcon({ name, tone }: { name: IconName; tone: BackofficeStatusTone | null }) {
  if (tone === null) {
    return <Icon name={name} className="size-4 shrink-0 text-[var(--bo-muted-2)]" />;
  }
  return (
    <span
      data-tone={tone}
      className="bo-status-tone flex size-8 shrink-0 items-center justify-center rounded-[4px] bg-[var(--bo-status-bg)] text-[var(--bo-status-color)]"
    >
      <Icon name={name} className="size-4" />
    </span>
  );
}
