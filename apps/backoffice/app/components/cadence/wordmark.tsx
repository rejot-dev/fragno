import { Link } from "react-router";

import { cn } from "@/lib/utils";

/**
 * The Cadence wordmark: a brass dot beside the serif logotype.
 */
export function CadenceWordmark({ className }: { className?: string }) {
  return (
    <Link to="/" className={cn("group flex flex-col gap-1", className)}>
      <span className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="h-2.5 w-2.5 rounded-full bg-[var(--cad-brass)] shadow-[0_0_14px_var(--cad-brass)] transition-transform group-hover:scale-110"
        />
        <span className="cad-display text-2xl leading-none text-[var(--cad-fg)]">cadence</span>
      </span>
    </Link>
  );
}
