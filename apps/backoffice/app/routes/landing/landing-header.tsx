import { ButtonLink } from "@fragno-private/design-system/button";
import { BackofficeFragmentMark } from "@fragno-private/design-system/fragment-mark";
import { Icon } from "@fragno-private/design-system/icon";
import { Link } from "react-router";

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
      <ButtonLink to="/backoffice" variant="ghost" className="no-underline">
        Open app
        <Icon name="arrow-right" className="size-3.5" />
      </ButtonLink>
    </header>
  );
}
