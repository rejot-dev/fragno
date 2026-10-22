import type { ReactNode } from "react";
import { Link } from "react-router";

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

const rowClassName = "group flex items-center gap-3 py-2.5";

/**
 * One row of a RowList: what it is, a line about it, and what it trails with, such as a time or a
 * status. With `to`, the whole row leads there, so its trailing content holds no links.
 */
export function ListRow({
  leading,
  title,
  detail,
  trailing,
  to,
}: {
  leading: ReactNode;
  title: string;
  detail: ReactNode;
  trailing: ReactNode;
  to: string | null;
}) {
  const content = (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-sm font-semibold text-[var(--bo-fg)] ${to === null ? "" : "group-hover:underline"}`}
          title={title}
        >
          {title}
        </span>
        {detail === null ? null : (
          <span className="block truncate text-xs text-[var(--bo-muted-2)]">{detail}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-3 text-xs">{trailing}</span>
    </>
  );
  return (
    <li>
      {to === null ? (
        <div className={rowClassName}>{content}</div>
      ) : (
        <Link to={to} className={rowClassName}>
          {content}
        </Link>
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
