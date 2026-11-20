import { LandingAgentsWrite } from "./agents-write";
import { LandingCases } from "./cases";
import { LandingGetStarted } from "./get-started";
import { LandingClosing } from "./hero";
import { LandingColumn as Column } from "./landing-section";
import { LandingPartners } from "./partners";

const GRID_LINE_CLASS_NAME = "border-[color-mix(in_srgb,var(--bo-fg)_7%,transparent)]";

/**
 * The homepage after its hero, in reading order: the two ways to start, example businesses running
 * on it, how an agent sets up each team's process, the partners who set it up, and the point of
 * view it closes on. The audit trail and tools sections are off the page for now.
 */
export function LandingHomeSections() {
  return (
    <>
      {/* Right under the dashboard demo, the two ways to start: alone in the app, or with the
          agency partner. */}
      <div className="mt-16 sm:mt-20">
        <LandingGetStarted />
      </div>
      {/* The header's Product link lands here; the margin keeps it clear of the sticky header. */}
      <div id="product" className="relative scroll-mt-16 pt-16 sm:pt-20">
        <div aria-hidden="true" className="landing-grid">
          {/* The hero's column lines, continued: the landing page's header publishes its columns
              as --landing-header-columns, and these sit on them, outset like its cells. */}
          <div className="max-w-landing mx-auto hidden h-full w-full px-5 sm:px-8 md:block lg:px-12">
            <div className="-mx-4 grid h-full grid-cols-[var(--landing-header-columns)]">
              <span className={`border-x ${GRID_LINE_CLASS_NAME}`} />
              <span />
              <span className={`border-l ${GRID_LINE_CLASS_NAME}`} />
              <span className={`border-x ${GRID_LINE_CLASS_NAME}`} />
            </div>
          </div>
        </div>
        <div className="relative">
          {/* The cases set their own column, like the sections below. */}
          <LandingCases />
        </div>
      </div>
      {/* Past the cases' grid, on the plain page, so nothing competes with the seam. */}
      <div className="pt-24 sm:pt-32">
        <Column>
          <LandingAgentsWrite />
        </Column>
      </div>
      <div className="pt-24 sm:pt-32">
        <Column>
          <LandingPartners />
        </Column>
      </div>
      {/* The page closes on the hero's black-and-gray film, in white, so it ends where it began. */}
      <div
        data-landing-dark
        className="relative mt-24 overflow-hidden bg-[#232322] pt-24 pb-24 text-white [--bo-bg:#232322] [--bo-fg:#fff] [--bo-muted-2:rgb(255_255_255/0.75)] [--bo-muted:rgb(255_255_255/0.9)] sm:mt-32 sm:pt-32 sm:pb-32"
      >
        <div aria-hidden="true" className="landing-film-mono" />
        <div className="relative">
          <Column>
            <LandingClosing />
          </Column>
        </div>
      </div>
    </>
  );
}
