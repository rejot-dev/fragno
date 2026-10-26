import type { ReactNode } from "react";

import { BackofficeFragmentMark } from "./fragment-mark";

/**
 * A Backoffice page outside its shell, such as signing in or setting up an account: the brand,
 * whatever the page shows in the header's other corner, the page's body, and its footer.
 */
export function StandalonePage({
  headerEnd,
  footer,
  children,
}: {
  headerEnd: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-backoffice-root
      className="relative isolate flex min-h-screen flex-col bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(0deg,rgba(var(--bo-overlay),0.96),rgba(var(--bo-overlay),0.96)),linear-gradient(90deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px),linear-gradient(0deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px)] bg-[size:100%_100%,28px_28px,28px_28px]" />
      <header className="mx-auto flex min-h-16 w-full max-w-[1180px] items-center justify-between gap-4 px-5 sm:px-8 lg:px-12">
        <a
          href="/"
          className="flex min-h-11 items-center gap-3 text-[10px] font-bold tracking-[0.16em] text-[var(--bo-fg)] uppercase no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--bo-accent)]"
          aria-label="ReJot Backoffice home"
        >
          <BackofficeFragmentMark size="md" />
          ReJot Backoffice
        </a>
        {headerEnd}
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
      {footer}
    </div>
  );
}

/** Who is signed in, with the control that signs them out, for a standalone page's header. */
export function StandalonePageAccount({ email, signOut }: { email: string; signOut: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <p className="min-w-0 truncate text-[var(--bo-muted)]">
        Signed in as <span className="font-semibold text-[var(--bo-fg)]">{email}</span>
      </p>
      {signOut}
    </div>
  );
}
