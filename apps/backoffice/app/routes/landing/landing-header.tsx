import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

import { BackofficeFragmentMark } from "@/components/backoffice/fragment-mark";

/** Provides the public Backoffice product header and app entry point. */
export function LandingHeader() {
  return (
    <header className="mx-auto flex min-h-16 w-full max-w-[1180px] items-center justify-between px-5 sm:px-8 lg:px-12">
      <Link
        to="/"
        className="flex min-h-11 items-center gap-3 text-[10px] font-bold tracking-[0.16em] text-[var(--bo-fg)] uppercase no-underline"
        aria-label="ReJot Backoffice home"
      >
        <BackofficeFragmentMark size="md" />
        ReJot Backoffice
      </Link>
      <Link
        to="/backoffice"
        className="inline-flex min-h-11 items-center gap-2 text-[10px] font-bold tracking-[0.14em] text-[var(--bo-muted)] uppercase no-underline transition-colors duration-150 hover:text-[var(--bo-fg)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--bo-accent)]"
      >
        Open app
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </Link>
    </header>
  );
}
