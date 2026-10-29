import { BackofficeFragmentMark } from "@fragno-private/design-system/fragment-mark";
import { Link } from "react-router";

const navLinkClassName =
  "inline-flex min-h-11 items-center px-3 text-sm font-medium text-[var(--bo-muted)] no-underline transition-colors duration-150 hover:text-[var(--bo-fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bo-accent)]";

/** The public header: the product, the marketplace, and the ways into the app. */
export function LandingHeader() {
  return (
    <header className="mx-auto flex min-h-16 w-full max-w-[1180px] items-center justify-between gap-4 px-5 sm:px-8 lg:px-12">
      <Link
        to="/"
        className="flex min-h-11 items-center gap-3 text-[10px] font-bold tracking-[0.16em] text-[var(--bo-fg)] uppercase no-underline"
        aria-label="ReJot Backoffice home"
      >
        <BackofficeFragmentMark size="md" />
        <span className="hidden sm:inline">ReJot Backoffice</span>
      </Link>
      <nav aria-label="Product" className="flex items-center">
        <Link to="/marketplace" className={navLinkClassName}>
          Marketplace
        </Link>
        <Link to="/backoffice/login" className={navLinkClassName}>
          Log in
        </Link>
        {/* The hero's main way in, at header size. */}
        <Link
          to="/backoffice/sign-up"
          className="ml-2 inline-flex min-h-10 items-center bg-[var(--bo-fg)] px-4 text-sm font-medium text-[var(--bo-bg)] no-underline transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--bo-fg)_86%,var(--bo-bg))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bo-accent)]"
        >
          Sign up
        </Link>
      </nav>
    </header>
  );
}
