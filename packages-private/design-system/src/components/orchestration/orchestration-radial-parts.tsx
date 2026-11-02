import type { ReactNode } from "react";

import { Icon, type IconName } from "../icon";

/** A Feather icon placed by its centre inside an SVG. */
export function SvgIcon({
  name,
  x,
  y,
  size,
  className,
}: {
  name: IconName;
  x: number;
  y: number;
  size: number;
  className: string;
}) {
  return (
    <g transform={`translate(${x - size / 2} ${y - size / 2}) scale(${size / 24})`}>
      <Icon name={name} className={className} strokeWidth={1.8} />
    </g>
  );
}

/** What the centre of a radial graph says about the scope or the item in focus. */
export function HubDetail({
  eyebrow,
  title,
  detail,
}: {
  eyebrow: string;
  title: string;
  detail: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-3 text-center">
      <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
        {eyebrow}
      </p>
      <p className="mt-1 line-clamp-2 text-[15px] leading-tight font-semibold break-words text-[var(--bo-fg)]">
        {title}
      </p>
      <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-[var(--bo-muted)]">
        {detail}
      </div>
    </div>
  );
}
