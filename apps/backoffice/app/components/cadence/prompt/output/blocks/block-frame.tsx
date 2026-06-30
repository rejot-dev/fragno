/*
 * Shared chrome for a stream block: an optional eyebrow title above the block
 * body, with consistent spacing. Keeps the individual renderers focused on their
 * payload rather than on framing.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function BlockFrame({
  title,
  icon,
  className,
  children,
}: {
  title?: string;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {title ? (
        <p className="cad-eyebrow flex items-center gap-1.5 text-[var(--cad-muted-2)]">
          {icon}
          {title}
        </p>
      ) : null}
      {children}
    </section>
  );
}
