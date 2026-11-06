import type { ReactNode } from "react";

import { LandingAgentsWrite } from "./agents-write";
import { LandingAuditTrail } from "./audit-trail";
import { LandingClosing } from "./hero";
import { LandingTools } from "./tools";

const GRID_LINE_CLASS_NAME = "border-[color-mix(in_srgb,var(--bo-fg)_7%,transparent)]";

/**
 * The homepage after its hero, in reading order: how an agent sets up each team's process, proof
 * of what ran, the tools it works with, and the point of view it closes on.
 */
export function LandingHomeSections() {
  return (
    <>
      <div className="relative pt-16 pb-24 sm:pt-24 sm:pb-32">
        <div aria-hidden="true" className="landing-grid">
          {/* The hero's column lines, continued: the landing page's header publishes its columns
              as --landing-header-columns, and these sit on them, outset like its cells. */}
          <div className="mx-auto hidden h-full w-full max-w-[1180px] px-5 sm:px-8 md:block lg:px-12">
            <div className="-mx-4 grid h-full grid-cols-[var(--landing-header-columns)]">
              <span className={`border-x ${GRID_LINE_CLASS_NAME}`} />
              <span />
              <span className={`border-l ${GRID_LINE_CLASS_NAME}`} />
              <span className={`border-x ${GRID_LINE_CLASS_NAME}`} />
            </div>
          </div>
        </div>
        <div className="relative">
          <Column>
            <LandingAgentsWrite />
          </Column>
        </div>
      </div>
      {/* The trace is the page's proof, so it breaks the rhythm: full width and dark, whatever
          theme the page is in, on the hero's film in black. A nested root takes on the dark palette,
          on pure black with neutral panels and lines (important, to outrank the palette's own
          blue-tinted ones), and `data-landing-dark` tells a header passing over it to turn white. */}
      <div className="dark" data-landing-dark>
        <div
          data-backoffice-root
          className="relative overflow-hidden bg-[var(--bo-bg)] py-20 text-[var(--bo-fg)] [--bo-bg:#000]! [--bo-border-strong:#3a3a3a]! [--bo-border:#262626]! [--bo-panel-2:#141414]! [--bo-panel:#0c0c0c]! sm:py-28"
        >
          <div aria-hidden="true" className="landing-film-dark" />
          <div className="relative">
            <Column>
              <LandingAuditTrail />
            </Column>
          </div>
        </div>
      </div>
      <div className="pt-24 sm:pt-32">
        <Column>
          <LandingTools />
        </Column>
      </div>
      {/* The page closes on the hero's red film, in white, so it ends where it began. */}
      <div
        data-landing-dark
        className="relative mt-24 overflow-hidden bg-[#d24a33] pt-24 pb-24 text-white [--bo-bg:#d24a33] [--bo-fg:#fff] [--bo-muted-2:rgb(255_255_255/0.75)] [--bo-muted:rgb(255_255_255/0.9)] sm:mt-32 sm:pt-32 sm:pb-32"
      >
        <div aria-hidden="true" className="landing-film" />
        <div className="relative">
          <Column>
            <LandingClosing />
          </Column>
        </div>
      </div>
    </>
  );
}

function Column({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1180px] px-7 sm:px-8 lg:px-12">{children}</div>;
}
