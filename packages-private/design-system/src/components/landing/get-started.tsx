import { Link } from "react-router";

import { Icon } from "../icon";
import { LANDING_SECTION_TITLE_CLASS_NAME, LandingColumn } from "./landing-section";
import { VelocityLogo } from "./velocity-logo";

const CARD_CLASS_NAME = "flex flex-col bg-[var(--bo-bg)] p-7 sm:p-9";
const EYEBROW_CLASS_NAME =
  "text-[11px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase";
const TITLE_CLASS_NAME =
  "font-heading mt-3 text-[clamp(1.75rem,2.6vw,2.25rem)] leading-[1.1] font-light tracking-[-0.04em] text-balance";
const BODY_CLASS_NAME = "mt-4 max-w-md text-base leading-7 text-pretty text-[var(--bo-muted)]";

/**
 * The two ways in, side by side on a plain band: start in the app straight away, or have the
 * agency partner set Leyway up with you.
 */
export function LandingGetStarted() {
  return (
    <section
      aria-labelledby="landing-get-started"
      className="bg-[var(--bo-panel)] py-20 text-[var(--bo-fg)] sm:py-24"
    >
      <LandingColumn>
        <h2 id="landing-get-started" className={LANDING_SECTION_TITLE_CLASS_NAME}>
          Start today, your way
        </h2>
        <div className="mt-10 grid gap-4 md:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
          <div className={CARD_CLASS_NAME}>
            <p className={EYEBROW_CLASS_NAME}>Do it yourself</p>
            <h3 className={TITLE_CLASS_NAME}>Start in one click</h3>
            <p className={BODY_CLASS_NAME}>
              Open the app, connect a tool, and describe how a process runs. Your first workflow is
              running in minutes, and you can try it before it touches anything real.
            </p>
            {/* The page's call to action again, slanted. Both cards' actions sit at their bottoms,
                level with each other. */}
            <div className="mt-auto pt-10">
              <Link
                to="/backoffice"
                className="group inline-flex h-12 items-center gap-2 bg-[#0b0b0a] px-9 text-sm font-semibold text-white no-underline transition-opacity duration-150 outline-none [clip-path:polygon(0.75rem_0,100%_0,calc(100%-0.75rem)_100%,0_100%)] hover:opacity-85 focus-visible:opacity-85"
              >
                {/* Trimmed to cap height and baseline, so the letters center in the button. */}
                <span className="[text-box:trim-both_cap_alphabetic]">Start automating</span>
                <Icon
                  name="arrow-right"
                  className="size-4 transition-transform duration-150 group-hover:translate-x-0.5"
                />
              </Link>
            </div>
          </div>
          <div className={CARD_CLASS_NAME}>
            <p className={EYEBROW_CLASS_NAME}>Done with you</p>
            <h3 className={TITLE_CLASS_NAME}>Get help from our agency</h3>
            <p className={BODY_CLASS_NAME}>
              Velocity, our dedicated agency partner, maps how your business runs, connects your
              tools, and builds your first automations with you.
            </p>
            <div className="mt-auto pt-10">
              {/* Slanted like the call to action beside it, in a light gray so the black one leads. */}
              <a
                href="https://www.velocity-ai.nl/"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Talk to Velocity"
                className="group inline-flex h-12 items-center gap-3 bg-[#e6e3df] px-9 no-underline transition-colors duration-150 outline-none [clip-path:polygon(0.75rem_0,100%_0,calc(100%-0.75rem)_100%,0_100%)] hover:bg-[#dcd8d3] focus-visible:bg-[#dcd8d3]"
              >
                <VelocityLogo tone="brand" />
                <Icon
                  name="arrow-right"
                  className="size-4 text-[var(--bo-fg)] transition-transform duration-150 group-hover:translate-x-0.5"
                />
              </a>
            </div>
          </div>
        </div>
      </LandingColumn>
    </section>
  );
}
