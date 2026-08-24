import { Link } from "react-router";

import { BackofficeFragmentMark } from "@/components/backoffice/fragment-mark";

const footerLinkClassName =
  "inline-flex min-h-10 items-center text-[10px] font-semibold tracking-[0.1em] text-[var(--bo-fg)] uppercase no-underline transition-colors duration-150 hover:text-[var(--bo-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bo-accent)]";

/** Provides the Backoffice product, community, and Fragno reference links. */
export function LandingFooter() {
  return (
    <footer className="mt-4 border-t border-[color:var(--bo-border)] bg-[color-mix(in_srgb,var(--bo-panel)_72%,transparent)] backdrop-blur-[10px]">
      <div className="mx-auto max-w-[1180px] px-5 py-16 sm:px-8 lg:px-12">
        <div className="grid gap-10 md:grid-cols-[1.3fr_0.7fr]">
          <div className="space-y-6">
            <Link
              to="/"
              className="inline-flex min-h-11 items-center gap-3 text-[10px] font-bold tracking-[0.12em] text-[var(--bo-fg)] uppercase no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--bo-accent)]"
              aria-label="Backoffice home"
            >
              <BackofficeFragmentMark size="md" />
              Backoffice by ReJot
            </Link>
            <p className="max-w-xs font-mono text-[11px] leading-6 text-pretty text-[var(--bo-muted)]">
              A controlled workspace for AI workflows, files, events, and integrations.
            </p>
          </div>

          <nav aria-labelledby="landing-footer-connect">
            <h2
              id="landing-footer-connect"
              className="font-mono text-[10px] font-bold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase"
            >
              Connect
            </h2>
            <ul className="mt-3 font-mono">
              <li>
                <a
                  className={footerLinkClassName}
                  href="https://github.com/rejot-dev"
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a
                  className={footerLinkClassName}
                  href="https://x.com/wilcokr"
                  target="_blank"
                  rel="noreferrer"
                >
                  X
                </a>
              </li>
              <li>
                <a
                  className={footerLinkClassName}
                  href="https://discord.gg/jdXZxyGCnC"
                  target="_blank"
                  rel="noreferrer"
                >
                  Discord
                </a>
              </li>
            </ul>
          </nav>
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-[color:var(--bo-border)] pt-8 font-mono text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase md:flex-row md:items-center md:justify-between">
          <p>© 2026 ReJot</p>
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="size-1.5 bg-[var(--bo-accent)]" />
            <span className="size-1.5 bg-[var(--bo-live)]" />
            <span className="size-1.5 bg-[var(--bo-accent)] opacity-45" />
            <span className="size-1.5 bg-[var(--bo-waiting)]" />
          </div>
        </div>
      </div>
    </footer>
  );
}
