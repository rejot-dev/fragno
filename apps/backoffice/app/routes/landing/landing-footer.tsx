import { LooppWordmark } from "@fragno-private/design-system/loopp-wordmark";
import { Link } from "react-router";

const footerLinkClassName =
  "inline-flex min-h-9 items-center text-sm font-semibold text-[var(--bo-fg)] no-underline transition-colors duration-150 hover:text-[var(--bo-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bo-accent)]";

/** Provides the Loopp product, community, and Fragno reference links. */
export function LandingFooter() {
  return (
    // A cool midnight closes the warm page. It stays fixed in both themes, so the footer redefines
    // the theme colors its content reads instead of each element naming its own.
    <footer className="mt-4 bg-[#111827] [--bo-accent:#f58a1f] [--bo-border:#273145] [--bo-fg:#f1f4f9] [--bo-muted-2:#7d899c] [--bo-muted:#a8b3c5]">
      <div className="mx-auto max-w-[1180px] px-5 py-16 sm:px-8 lg:px-12">
        <div className="grid gap-10 md:grid-cols-[1.3fr_0.7fr]">
          <div className="space-y-6">
            <Link
              to="/"
              className="inline-flex min-h-11 items-center gap-2.5 text-sm font-extrabold text-[var(--bo-fg)] no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--bo-accent)]"
              aria-label="Loopp home"
            >
              <LooppWordmark className="h-7" animated={false} />
              <span className="mt-1.5 text-[10px] font-semibold text-[var(--bo-muted-2)]">
                by ReJot
              </span>
            </Link>
            <p className="max-w-xs text-sm leading-6 text-pretty text-[var(--bo-muted)]">
              AI that shows its work.
            </p>
          </div>

          <nav aria-labelledby="landing-footer-connect">
            <h2
              id="landing-footer-connect"
              className="text-[11px] font-semibold text-[var(--bo-muted-2)]"
            >
              Connect
            </h2>
            <ul className="mt-3">
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

        <div className="mt-14 flex flex-col gap-4 border-t border-[color:var(--bo-border)] pt-8 text-xs text-[var(--bo-muted-2)] md:flex-row md:items-center md:justify-between">
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
