import { Icon, type IconName } from "@fragno-private/design-system/icon";
import { SurfaceSection } from "@fragno-private/design-system/surface-panel";
import { Link } from "react-router";

/** A place listed to open: a firm, a client, or an administration, and whether the person may. */
export type ListedPlace = { name: string; path: string; member: boolean };

/** The places of one kind, each opening where it leads; those the person is not in show why not. */
export function PlaceList({
  title,
  icon,
  places,
}: {
  title: string;
  icon: IconName;
  places: readonly ListedPlace[];
}) {
  return (
    <SurfaceSection title={title} meta={String(places.length)} actions={null}>
      <ul className="divide-y divide-[var(--bo-border)] border-t border-[color:var(--bo-border)]">
        {places.map(({ name, path, member }) => {
          const row = (
            <>
              <Icon name={icon} className="size-4 text-[var(--bo-muted)]" />
              {name}
              {member ? (
                <Icon name="chevron-right" className="ml-auto size-4 text-[var(--bo-muted-2)]" />
              ) : (
                <span className="ml-auto text-xs font-normal text-[var(--bo-muted)]">
                  You're not a member
                </span>
              )}
            </>
          );
          const className = "flex min-h-12 items-center gap-3 px-4 text-sm font-medium";
          return (
            <li key={path}>
              {member ? (
                <Link
                  to={path}
                  className={`${className} text-[var(--bo-fg)] transition-colors duration-150 hover:bg-[var(--bo-panel-2)]`}
                >
                  {row}
                </Link>
              ) : (
                <div className={`${className} text-[var(--bo-muted)]`}>{row}</div>
              )}
            </li>
          );
        })}
      </ul>
    </SurfaceSection>
  );
}
