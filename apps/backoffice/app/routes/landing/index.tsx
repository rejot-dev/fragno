import "./landing.css";
import "@fragno-private/design-system/components.css";

import { headingFontLatinUrl } from "@fragno-private/design-system/brand-font";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import {
  PillArrow,
  PillButtonLink,
  PillLabel,
} from "@fragno-private/design-system/controls/pill-button";
import { LoadingBar } from "@fragno-private/design-system/feedback/loading-bar";
import { LandingHeroPhoto } from "@fragno-private/design-system/landing/hero-photo";
import { LandingHomeSections } from "@fragno-private/design-system/landing/home";
import { lazy, Suspense } from "react";

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
      {/* As tall as the timeline bar, which on phones adds a line for the playing chapter's title. */}
      <ScreenFrame
        label="The Leyway dashboard demo"
        bar={<div className="min-h-14 max-sm:min-h-21" />}
      >
        {null}
      </ScreenFrame>
      {/* Above the timeline bar, which is as tall as its sections. */}
      <div className="absolute inset-x-0 top-0 bottom-14 flex items-center justify-center max-sm:bottom-21">
        {/* In the preview's black and white, like the screen it stands in for. */}
        <div className="w-48 grayscale">
          <LoadingBar label="Loading the Leyway dashboard demo" />
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const scrolled = useScrolled();

  return (
    <div
      data-backoffice-root
      className="bo-grid-backdrop min-h-svh overflow-x-clip bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <LandingHeader startsOverDark={true} nav="product" />
      {/* Only the page's own content is main, so the header and footer keep their banner and
          contentinfo landmarks. */}
      <main>
        {/* The hero's grainy black and gray stays fixed in both themes, so it reads the same for
          everyone. It runs up behind the header, the header's height and its border, and is padded
          back down by the same, so the header blurs it from the top of the page. */}
        <section
          data-scrolled={scrolled || undefined}
          data-landing-dark
          className="group/hero relative -mt-[calc(var(--spacing)*16+1px)] overflow-hidden bg-[#232322] pt-[calc(var(--spacing)*16+1px)] text-white"
        >
          {/* The photo lies inside the film, so its grain covers the photo too. */}
          {/* The film's vignette at about half its usual strength: the photo's shade adds its own,
            and together they closed in on the photo. */}
          <div
            aria-hidden="true"
            className="landing-film-mono shadow-[inset_0_0_14rem_2rem_rgb(0_0_0/0.28)]!"
          >
            <LandingHeroPhoto photo="fitz-roy" />
          </div>
          {/* The bottom padding is the dashboard's overlap (-mt-36, -mt-44 on lg) plus the YC pill's
            reach below the copy (its offset plus half its height, 0.75rem) plus a 1.5rem gap, so
            the pill sits just above the dashboard. */}
          <div className="max-w-landing mx-auto flex w-full items-center px-7 pt-[3.625rem] pb-[calc(var(--spacing)*36+6.5rem+1.5rem)] sm:min-h-[min(920px,calc(100svh-1rem))] sm:px-8 sm:pt-[5.25rem] sm:pb-[calc(var(--spacing)*36+7.25rem+1.5rem)] lg:min-h-0 lg:px-12 lg:pt-[11.375rem] lg:pb-[calc(var(--spacing)*44+8.75rem+1.5rem)]">
            <div className="landing-hero-fold relative min-w-0 flex-1">
              <div className="landing-hero-copy relative z-10 text-center lg:text-left">
                {/* Set open rather than tight: near-natural spacing and a little air between the
                  lines, in one white, so the heading reads calm over the photo. */}
                {/* From lg up, where the copy sits left, the "A"'s ink starts 0.037em right of its
                  origin in this font, weight and tracking; the margin pulls it back so the
                  heading's ink lines up with the paragraph below. */}
                <h1 className="font-heading mx-auto max-w-[1040px] text-[clamp(2.5rem,5.75vw,5rem)] leading-[1.05] font-light tracking-[-0.02em] text-balance lg:mr-0 lg:-ml-[0.037em] lg:text-[76.5px]">
                  Automate your
                  <br />
                  business with AI
                </h1>
                <p className="mx-auto mt-8 max-w-2xl text-xl leading-8 text-pretty text-white lg:mx-0">
                  Turn business processes into workflows. Connect your tools and apps to Leyway and
                  let AI build automations. Deterministic and auditable.
                </p>
                {/* From lg up, laid on the header's columns like its lines, each button half the
                  header's outset from the line before it, and the first filling its column to the
                  same distance from the next line, so the two sit as close as they did side by side.
                  The first column's lines both lie inside it, a pixel further in. Until the header
                  publishes its columns, the two sit side by side. The pills draw in the hero's
                  white ink. */}
                <div className="mt-10 flex flex-wrap justify-center gap-3 [--bo-bg:#0b0b0a] [--bo-fg:#ffffff] lg:-mx-4 lg:grid lg:grid-cols-[var(--landing-header-columns,auto_1fr)] lg:gap-0">
                  <PillButtonLink
                    to="/backoffice"
                    variant="filled"
                    size="default"
                    ring={false}
                    className="justify-self-start lg:mx-[calc(var(--spacing)*2+1px)] lg:justify-self-stretch"
                  >
                    <PillLabel>Open app</PillLabel>
                    <PillArrow />
                  </PillButtonLink>
                  <PillButtonLink
                    to="/marketplace"
                    variant="outlined"
                    size="default"
                    ring={false}
                    className="justify-self-start lg:ml-2"
                  >
                    <PillLabel>Browse the marketplace</PillLabel>
                  </PillButtonLink>
                </div>
              </div>
              {/* Below the copy, centered on the page like the copy and the header's logo. The
                header's free middle column is not: its links are wider on the right. */}
              <div className="landing-hero-copy absolute inset-x-0 top-[calc(100%+5.75rem)] z-10 flex -translate-y-1/2 justify-center sm:top-[calc(100%+6.5rem)] lg:top-[calc(100%+8rem)]">
                {/* Leaves the site for Y Combinator's, so it opens in a new tab. */}
                <a
                  href="https://www.ycombinator.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group/yc inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/20 py-1 pr-4 pl-2 text-xs font-medium text-white no-underline backdrop-blur-sm transition-colors duration-150 outline-none hover:bg-white/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  {/* A white disc with the Y cut out of it, so the pill shows through the letter. The
                    baseline sits half the font's cap height below the center, centering the Y. On
                    hover, Y Combinator's own orange with a white Y grows out of its center over it,
                    overshooting a little before it settles; with reduced motion it only fades in. */}
                  <svg aria-hidden="true" viewBox="0 0 14 14" className="size-3.5">
                    <mask id="landing-yc-cutout">
                      <rect width="14" height="14" fill="#ffffff" />
                      <text
                        x="7"
                        y="10.2"
                        textAnchor="middle"
                        fontSize="9"
                        fontWeight="700"
                        fill="#000000"
                      >
                        Y
                      </text>
                    </mask>
                    <circle cx="7" cy="7" r="7" fill="#ffffff" mask="url(#landing-yc-cutout)" />
                    <g className="origin-center scale-0 opacity-0 transition-[opacity,scale] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] [transform-box:fill-box] group-hover/yc:scale-100 group-hover/yc:opacity-100 motion-reduce:scale-100">
                      <circle cx="7" cy="7" r="7" fill="#ff6600" />
                      <text
                        x="7"
                        y="10.2"
                        textAnchor="middle"
                        fontSize="9"
                        fontWeight="700"
                        fill="#ffffff"
                      >
                        Y
                      </text>
                    </g>
                  </svg>
                  Backed by Y Combinator
                </a>
              </div>
            </div>
          </div>
          {/* Over the connections, under the copy. */}
          <LandingColumnLines />
        </section>

        {/* The dashboard overlaps the hero's lower edge, so the product is the first thing under the
          pitch. It stops at 960px across, narrower than the page's column, so it stays a preview
          rather than filling wide screens; on ultra-wide screens, where the column widens too, it
          stops at 1100px. Its screen is shown in a light black and white (DashboardDemoPlayer). */}
        <div className="relative z-20 -mt-36 lg:-mt-44">
          {/* Shade on the page below the hero's lower edge, where the dashboard's overlap ends,
            behind the dashboard. It fades in once the page scrolls, with the hero's column lines. */}
          <div
            aria-hidden="true"
            className={`landing-hero-crease top-36 transition-opacity duration-300 ease-out lg:top-44 ${scrolled ? "opacity-100" : "opacity-0"}`}
          />
          <div className="relative mx-auto w-full max-w-[calc(960px+var(--spacing)*24)] px-5 min-[1920px]:max-w-[calc(1100px+var(--spacing)*24)] sm:px-8 lg:px-12">
            <ClientOnly fallback={<DashboardDemoLoading />}>
              <Suspense fallback={<DashboardDemoLoading />}>
                <DashboardDemo />
              </Suspense>
            </ClientOnly>
          </div>
        </div>
        <LandingHomeSections />
      </main>

      <LandingFooter />
    </div>
  );
}
