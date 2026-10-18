import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

import { seededColor } from "./seeded-color";

export type PresencePerson = {
  /** A stable identity; it seeds the tile colour. */
  id: string;
  initials: string;
  name: string;
  email: string;
  /** What they are doing, such as where they are and how recently they were active. */
  activity: string;
};

const VISIBLE_PEOPLE = 3;
// Tooltips portal to the body, so they must clear the sticky top bar and its menus.
const POPUP_Z_INDEX = 2147483647;

const tileClassName =
  "flex size-7 cursor-default items-center justify-center rounded-[6px] text-[11px] font-semibold ring-2 ring-[color:var(--bo-bg)] outline-none focus-visible:ring-[color:var(--bo-accent)]";

function PersonDetails({ person }: { person: PresencePerson }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-semibold text-[var(--bo-fg)]">{person.name}</span>
      <span className="truncate text-[var(--bo-muted)]">{person.email}</span>
      <span className="truncate text-[var(--bo-muted-2)]">{person.activity}</span>
    </span>
  );
}

function PresenceTile({
  label,
  className,
  style,
  tooltip,
  children,
}: {
  label: string;
  className: string;
  style?: { backgroundColor: string };
  tooltip: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="-ml-1.5 flex first:ml-0">
      <Tooltip.Root>
        <Tooltip.Trigger aria-label={label} style={style} className={className}>
          {children}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner side="bottom" sideOffset={6} style={{ zIndex: POPUP_Z_INDEX }}>
            <Tooltip.Popup
              data-backoffice-root
              className="bo-popover-surface flex max-w-72 flex-col gap-2 rounded-[6px] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2.5 py-2 text-xs transition-[opacity,scale] duration-150 ease-out data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"
            >
              {tooltip}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </li>
  );
}

function personLabel(person: PresencePerson) {
  return `${person.name} (${person.email}), ${person.activity}`;
}

/**
 * Overlapping tiles for the people who are around; those beyond the first few collapse into a
 * count. Hovering or focusing a tile shows who it stands for.
 */
export function PresenceStack({ people }: { people: readonly PresencePerson[] }) {
  if (people.length === 0) {
    return null;
  }
  const visible = people.slice(0, VISIBLE_PEOPLE);
  const hidden = people.slice(VISIBLE_PEOPLE);

  return (
    // A short shared delay lets the pointer move along the stack without waiting at every tile.
    <Tooltip.Provider delay={150}>
      <ul
        aria-label={`${people.length} ${people.length === 1 ? "person" : "people"} active`}
        className="flex items-center"
      >
        {visible.map((person) => (
          <PresenceTile
            key={person.id}
            label={personLabel(person)}
            style={{ backgroundColor: seededColor(person.id) }}
            className={`${tileClassName} text-white`}
            tooltip={<PersonDetails person={person} />}
          >
            {person.initials}
          </PresenceTile>
        ))}
        {hidden.length > 0 ? (
          <PresenceTile
            label={hidden.map(personLabel).join("; ")}
            className={`${tileClassName} bg-[var(--bo-panel-2)] text-[var(--bo-muted)]`}
            tooltip={hidden.map((person) => (
              <PersonDetails key={person.id} person={person} />
            ))}
          >
            +{hidden.length}
          </PresenceTile>
        ) : null}
      </ul>
    </Tooltip.Provider>
  );
}
