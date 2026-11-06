import "./landing.css";
import "@fragno-private/design-system/components.css";

import { headingFontLatinUrl } from "@fragno-private/design-system/brand-font";
import { Icon } from "@fragno-private/design-system/icon";
import { LandingHomeSections } from "@fragno-private/design-system/landing/home";
import { Link } from "react-router";

import { DashboardDemoPlayer } from "./dashboard-demo/dashboard-demo-player";
import { DASHBOARD_DEMO_STATE } from "./dashboard-demo/dashboard-demo-state";
import { LandingConnectionsCycle } from "./landing-connections-cycle";
import { LandingFooter } from "./landing-footer";
import { LandingColumnLines, LandingColumns, LandingHeader } from "./landing-header";
import { useScrolled } from "./use-scrolled";

// Preloaded like the brand font in root.tsx, so the headings paint in Space Grotesk from the start.
export function links() {
  return [
    {
      rel: "preload",
      as: "font",
      type: "font/woff2",
      href: headingFontLatinUrl,
      crossOrigin: "anonymous",
    },
  ];
}

export function meta() {
  const title = "Leyway — AI that shows its work";
  const description =
    "Describe how your business runs, and Leyway writes it as workflows you can read. They run the same way every time, ask before they act, and record every step.";
  const ogImage = "https://leyway.com/og-image.png";

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

      {/* The hero's grainy red stays fixed in both themes, so it reads the same for everyone. It
          runs up behind the header, the header's height and its border, and is padded back down by
          the same, so the header blurs it from the top of the page. */}
      <section
        data-scrolled={scrolled || undefined}
        data-landing-dark
        className="group/hero relative -mt-[calc(var(--spacing)*16+1px)] overflow-hidden bg-[#d24a33] pt-[calc(var(--spacing)*16+1px)] text-white"
      >
        <div aria-hidden="true" className="landing-film" />
        {/* The bottom padding is the dashboard's overlap (-mt-36, -mt-44 on lg) plus the YC pill's
            reach below the copy (5.75rem) plus the top padding, so the copy and pill sit centered
            between the header and the dashboard. */}
        <div className="mx-auto flex w-full max-w-[1180px] items-center px-7 pt-[2.875rem] pb-[calc(var(--spacing)*36+5.75rem+2.875rem)] sm:min-h-[min(860px,calc(100svh-4rem))] sm:px-8 sm:pt-[4.25rem] sm:pb-[calc(var(--spacing)*36+5.75rem+4.25rem)] lg:min-h-0 lg:px-12 lg:pt-[9.875rem] lg:pb-[calc(var(--spacing)*44+5.75rem+9.875rem)]">
          <div className="landing-hero-fold relative min-w-0 flex-1">
            {/* The connections pass beside the copy, across the screen, fading out towards the
                hero's top and bottom. Below lg there is no room beside it, so they stay hidden and
                the copy centers instead. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -inset-y-16 left-[calc(50%-50vw)] hidden w-screen [mask-image:linear-gradient(transparent,#000_5rem,#000_calc(100%-5rem),transparent)] lg:block"
            >
              {/* Centered on the copy. Its right edge is the hub's center, placed at the center of
                  the header's last cell: past the content column's padding, out by the cells' outset
                  from md up, and back by half the cell. Past the content width it stays there instead
                  of drifting to the viewport's edge. */}
              <div className="landing-hero-copy absolute top-1/2 right-[calc(max(0px,(100%-1180px)/2)+var(--landing-cycle-pad)-var(--landing-cycle-outset)+var(--landing-header-open-width,128px)/2)] origin-right -translate-y-1/2 scale-(--landing-cycle-scale) text-white [--landing-cycle-outset:0px] [--landing-cycle-pad:calc(var(--spacing)*5)] [--landing-cycle-scale:0.6] sm:[--landing-cycle-pad:calc(var(--spacing)*8)] sm:[--landing-cycle-scale:0.75] md:[--landing-cycle-outset:calc(var(--spacing)*4)] lg:[--landing-cycle-pad:calc(var(--spacing)*12)] lg:[--landing-cycle-scale:1]">
                <LandingConnectionsCycle />
              </div>
            </div>
            <div className="landing-hero-copy relative z-10 text-center lg:text-left">
              <h1 className="font-heading mx-auto max-w-[1040px] text-[clamp(2.75rem,6.5vw,5.75rem)] leading-[0.95] font-light tracking-[-0.06em] text-balance lg:mx-0">
                Automate your
                <br />
                <span className="text-white/80">business with AI</span>
              </h1>
              <p className="mx-auto mt-8 max-w-2xl text-lg leading-8 text-pretty text-white/95 lg:mx-0">
                Turn business processes into workflows. Connect your tools and apps to Leyway and
                let AI build automations. Deterministic and auditable.
              </p>
              <div className="mt-10 flex flex-wrap justify-center gap-3 lg:justify-start">
                <Link
                  to="/backoffice"
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[6px] bg-white px-6 text-sm font-semibold text-[#b93a28] no-underline transition-opacity duration-150 hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
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
            {/* Below the copy; from md up, centered between the lines of the header's free middle
                column. */}
            <div className="landing-hero-copy absolute inset-x-0 top-[calc(100%+5rem)] z-10 -translate-y-1/2">
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
        {/* Over the connections, under the copy. */}
        <LandingColumnLines />
      </section>

      {/* The dashboard overlaps the hero's lower edge, so the product is the first thing under the
          pitch. */}
      <div className="landing-hero-device relative z-20 mx-auto -mt-36 w-full max-w-[1180px] px-5 sm:px-8 lg:-mt-44 lg:px-12">
        <DashboardDemoPlayer state={DASHBOARD_DEMO_STATE} />
      </div>
      <LandingHomeSections />

      <LandingFooter />
    </main>
  );
}
