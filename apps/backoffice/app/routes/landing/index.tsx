import "./landing.css";
import "@fragno-private/design-system/components.css";

import { headingFontLatinUrl } from "@fragno-private/design-system/brand-font";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import { LoadingBar } from "@fragno-private/design-system/feedback/loading-bar";
import { Icon } from "@fragno-private/design-system/icon";
import { LandingHeroPhoto } from "@fragno-private/design-system/landing/hero-photo";
import { LandingHomeSections } from "@fragno-private/design-system/landing/home";
import { lazy, Suspense } from "react";
import { Link } from "react-router";

import { ScreenFrame } from "./dashboard-demo/screen-frame";
import { LandingFooter } from "./landing-footer";
import { LandingColumnLines, LandingHeader } from "./landing-header";
import { useScrolled } from "./use-scrolled";

// Preloaded like the brand font in root.tsx, so the headings paint in Outfit from the start.
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

// The loading bar shows at least this long, even when the demo's chunk is already cached, so it
// reads as the demo arriving rather than a flicker.
const DASHBOARD_DEMO_MIN_LOADING_MS = 800;

// The dashboard demo is the page's heaviest part, so it loads in the browser after the page
// renders, in its own chunk; the server renders only its placeholder.
const DashboardDemo = lazy(async () => {
  const [{ DashboardDemoPlayer }, { DASHBOARD_DEMO_STATE }] = await Promise.all([
    import("./dashboard-demo/dashboard-demo-player"),
    import("./dashboard-demo/dashboard-demo-state"),
    new Promise((resolve) => {
      setTimeout(resolve, DASHBOARD_DEMO_MIN_LOADING_MS);
    }),
  ]);
  return { default: () => <DashboardDemoPlayer state={DASHBOARD_DEMO_STATE} /> };
});

/**
 * The demo's empty frame while it loads: the same screen and timeline bar, so nothing shifts when
 * the demo arrives, with a loading bar centered on the screen. The loading bar lies over the frame
 * rather than in it, since the frame hides its screen until it has measured itself in the browser.
 */
function DashboardDemoLoading() {
  return (
    <div className="relative">
      <ScreenFrame label="The Leyway dashboard demo" bar={<div className="min-h-11" />}>
        {null}
      </ScreenFrame>
      {/* Above the timeline bar, which is as tall as its sections. */}
      <div className="absolute inset-x-0 top-0 bottom-11 flex items-center justify-center">
        <div className="w-48">
          <LoadingBar label="Loading the Leyway dashboard demo" />
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const scrolled = useScrolled();

  return (
    <main
      data-backoffice-root
      className="bo-grid-backdrop min-h-svh overflow-x-clip bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <LandingHeader />

      {/* The hero's grainy black and gray stays fixed in both themes, so it reads the same for
          everyone. It runs up behind the header, the header's height and its border, and is padded
          back down by the same, so the header blurs it from the top of the page. */}
      <section
        data-scrolled={scrolled || undefined}
        data-landing-dark
        className="group/hero relative -mt-[calc(var(--spacing)*16+1px)] overflow-hidden bg-[#232322] pt-[calc(var(--spacing)*16+1px)] text-white"
      >
        {/* The photo lies inside the film, so its grain covers the photo too. */}
        <div aria-hidden="true" className="landing-film-mono">
          <LandingHeroPhoto photo="fitz-roy" />
        </div>
        {/* The bottom padding is the dashboard's overlap (-mt-36, -mt-44 on lg) plus the YC pill's
            reach below the copy (5.75rem) plus a gap less than the top padding, so the pill sits
            close above the dashboard. */}
        <div className="max-w-landing mx-auto flex w-full items-center px-7 pt-[2.875rem] pb-[calc(var(--spacing)*36+5.75rem+1.5rem)] sm:min-h-[min(860px,calc(100svh-4rem))] sm:px-8 sm:pt-[4.25rem] sm:pb-[calc(var(--spacing)*36+5.75rem+2rem)] lg:min-h-0 lg:px-12 lg:pt-[9.875rem] lg:pb-[calc(var(--spacing)*44+5.75rem+3rem)]">
          <div className="landing-hero-fold relative min-w-0 flex-1">
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
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[6px] bg-white px-6 text-sm font-semibold text-[#0b0b0a] no-underline transition-opacity duration-150 hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  {/* Trimmed to cap height and baseline, so the letters center on the arrow. */}
                  <span className="[text-box:trim-both_cap_alphabetic]">Open app</span>
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
            {/* Below the copy, centered on the page like the copy and the header's logo. The
                header's free middle column is not: its links are wider on the right. */}
            <div className="landing-hero-copy absolute inset-x-0 top-[calc(100%+5rem)] z-10 flex -translate-y-1/2 justify-center">
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
          </div>
        </div>
        {/* Over the connections, under the copy. */}
        <LandingColumnLines />
      </section>

      {/* The dashboard overlaps the hero's lower edge, so the product is the first thing under the
          pitch. It stops at 960px across, narrower than the page's column, so it stays a preview
          rather than filling wide screens; on ultra-wide screens, where the column widens too, it
          stops at 1100px. */}
      <div className="relative z-20 mx-auto -mt-36 w-full max-w-[calc(960px+var(--spacing)*24)] px-5 min-[1920px]:max-w-[calc(1100px+var(--spacing)*24)] sm:px-8 lg:-mt-44 lg:px-12">
        <ClientOnly fallback={<DashboardDemoLoading />}>
          <Suspense fallback={<DashboardDemoLoading />}>
            <DashboardDemo />
          </Suspense>
        </ClientOnly>
      </div>
      <LandingHomeSections />

      <LandingFooter />
    </main>
  );
}
