import { Icon } from "@fragno-private/design-system/icon";
import { StandalonePage } from "@fragno-private/design-system/standalone-page";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { LandingFooter } from "@/routes/landing/landing-footer";

/** Backoffice's pages outside its shell, signing in and setting up, under the site's footer. */
export function BackofficeStandaloneLayout({
  headerEnd,
  children,
}: {
  headerEnd: ReactNode;
  children: ReactNode;
}) {
  return (
    <StandalonePage headerEnd={headerEnd} footer={<LandingFooter />}>
      {children}
    </StandalonePage>
  );
}

/** The way back to the landing page, for pages people reach before they are signed in. */
export function BackToHomeLink() {
  return (
    <Link
      to="/"
      className="inline-flex min-h-11 items-center gap-2 text-[10px] font-bold tracking-[0.14em] text-[var(--bo-muted)] uppercase no-underline transition-colors duration-150 hover:text-[var(--bo-fg)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--bo-accent)]"
    >
      <Icon name="arrow-left" className="size-3.5" />
      Back to home
    </Link>
  );
}
