import "./landing.css";
import "@fragno-private/design-system/components.css";

import { LandingHomeSections } from "@fragno-private/design-system/landing/home";
import { Icon } from "@fragno-private/design-system/icon";
import { loopLaneBelowTop, LooppLoopAround } from "@fragno-private/design-system/loopp-wordmark";
import { Link } from "react-router";

import { DashboardDemo } from "./dashboard-demo/dashboard-demo";
import { DASHBOARD_DEMO_STATE } from "./dashboard-demo/dashboard-demo-state";
import { LaptopFrame } from "./dashboard-demo/laptop-frame";
import { LandingConnectionsCycle } from "./landing-connections-cycle";
import { LandingFooter } from "./landing-footer";
import { LandingColumnLines, LandingColumns, LandingHeader } from "./landing-header";
import { useScrolled } from "./use-scrolled";

export function meta() {
  const title = "Loopp by ReJot — Automate your business with AI";
  const description =
    "Describe how your business runs, and Loopp writes it as workflows you can read. They run the same way every time, ask before they act, and record every step.";
  const ogImage = "https://backoffice.rejot.dev/og-image.png";

  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:image", content: ogImage },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: title },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: ogImage },
  ];
}

export default function LandingPage() {
  const scrolled = useScrolled();

  return (
    <main
      data-backoffice-root
      className="bo-grid-backdrop min-h-svh overflow-x-clip bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <LandingHeader />

      {/* The hero's amber palette stays fixed in both themes, so it reads the same for
          everyone. */}
      <section
        data-scrolled={scrolled || undefined}
        className="group/hero relative overflow-hidden bg-[#f58a1f] text-white"
      >
        <div aria-hidden="true" className="landing-hero-lights opacity-30" />
        {/* The bottom padding is the dashboard's overlap (-mt-28, -mt-36 on lg) plus room for the loop
            below the copy and the lane under it, which holds the YC pill. */}
        <div className="mx-auto flex w-full max-w-[1180px] items-center px-5 pt-10 pb-[calc(var(--spacing)*28+8rem)] sm:min-h-[min(760px,calc(100svh-4rem))] sm:px-8 sm:pt-20 lg:min-h-0 lg:px-12 lg:pt-51 lg:pb-[calc(var(--spacing)*36+8rem)]">
          <div className="relative min-w-0 flex-1">
            {/* The logo's loop, framing the copy and the content column at every screen size. Its
                band is opaque burnt amber, with faint lanes and pale gold light; the connection icons pass
                behind it, fading out as they near it, and the copy stays on top. */}
            <LooppLoopAround
              holeWidth="1560px"
              behind={
                // Centered on the copy. Its right edge is the hub's center, placed at the center of
                // the header's last cell: past the content column's padding, out by the cells' outset
                // from md up, and back by half the cell. Past the content width it stays there
                // instead of drifting to the viewport's edge.
                <div className="landing-hero-copy absolute top-1/2 right-[calc(max(0px,(100%-1180px)/2)+var(--landing-cycle-pad)-var(--landing-cycle-outset)+var(--landing-header-open-width,128px)/2)] origin-right -translate-y-1/2 scale-(--landing-cycle-scale) text-white [--landing-cycle-outset:0px] [--landing-cycle-pad:calc(var(--spacing)*5)] [--landing-cycle-scale:0.6] sm:[--landing-cycle-pad:calc(var(--spacing)*8)] sm:[--landing-cycle-scale:0.75] md:[--landing-cycle-outset:calc(var(--spacing)*4)] lg:[--landing-cycle-pad:calc(var(--spacing)*12)] lg:[--landing-cycle-scale:1]">
                  <LandingConnectionsCycle />
                </div>
              }
              className="text-[#e8730f] [--loopp-loop-lane:rgb(255_255_255/0.12)] [--loopp-loop-particle:#ffe0a8]"
            />
            <div className="landing-hero-copy relative z-10">
              <h1 className="max-w-[1040px] text-[clamp(2.75rem,6.5vw,5.75rem)] leading-[0.95] font-semibold tracking-[-0.045em] text-balance">
                Automate your
                <br />
                <span className="text-white/80">business with AI</span>
              </h1>
              <p className="mt-8 max-w-2xl text-lg leading-8 text-pretty text-white/95">
                Turn business processes into workflows. Connect your tools and apps to Loopp and let
                AI build automations. Deterministic and auditable.
              </p>
              {/* From md up, the first button fills the logo's column, inset from both of its lines as
                  the copy is from the outer one (the header's -mx-4), and the second starts as far
                  past the line between them, less the line's own pixel. */}
              <div className="mt-10 flex flex-wrap gap-3 md:gap-[calc(var(--spacing)*8-1px)]">
                <Link
                  to="/backoffice"
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[6px] bg-white px-6 text-sm font-semibold text-[#c2560a] no-underline transition-opacity duration-150 hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white md:w-[calc(var(--landing-header-logo-width)-var(--spacing)*8)] md:px-0"
                >
                  Open app
                  <Icon name="arrow-right" className="size-4" />
                </Link>
                <Link
                  to="/marketplace"
                  className="inline-flex min-h-12 items-center rounded-[6px] border border-white/30 px-6 text-sm font-semibold text-white no-underline transition-colors duration-150 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  Browse the marketplace
                </Link>
              </div>
            </div>
            {/* In the lane just below the loop's opening; from md up, centered between the lines
                of the header's free middle column. */}
            <div
              className="landing-hero-copy absolute inset-x-0 z-10 -translate-y-1/2"
              style={{ top: loopLaneBelowTop(0) }}
            >
              <LandingColumns className="flex justify-center">
                <div className="flex justify-center md:col-start-2">
                  <p className="inline-flex items-center gap-1.5 rounded-full bg-white/15 py-1 pr-4 pl-2 text-xs font-medium text-white/80">
                    <span
                      aria-hidden="true"
                      className="flex size-3.5 items-center justify-center rounded-full bg-[#f26522] text-[9px] leading-none font-bold text-white"
                    >
                      Y
                    </span>
                    Backed by Y Combinator
                  </p>
                </div>
              </LandingColumns>
            </div>
          </div>
        </div>
        {/* Over the loop, under the copy. */}
        <LandingColumnLines />
      </section>

      {/* The dashboard overlaps the hero's lower edge, so the product is the first thing under the
          pitch. */}
      <div className="landing-hero-device relative z-20 mx-auto -mt-28 w-full max-w-[1180px] px-5 sm:px-8 lg:-mt-36 lg:px-12">
        <LaptopFrame label="The Loopp dashboard: what needs attention, how events route to workflows and agents, and how each automation is running.">
          <DashboardDemo state={DASHBOARD_DEMO_STATE} />
        </LaptopFrame>
      </div>
      <LandingHomeSections />

      <LandingFooter />
    </main>
  );
}
