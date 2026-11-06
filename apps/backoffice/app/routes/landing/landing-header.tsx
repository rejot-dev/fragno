import { LeywayWordmark } from "@fragno-private/design-system/brand/leyway-wordmark";
import { Icon } from "@fragno-private/design-system/icon";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { useScrolled } from "./use-scrolled";

// Mirrors the cells of the app's top bar, aligned to the page's content column. Every cell hugs
// its item with the same padding. Once the page scrolls under the header, lines frame the cells and
// the hero continues them downward; from md up, the hero's lines follow the cells' measured widths.
const containerClassName = "mx-auto w-full max-w-[1180px] px-7 sm:px-8 lg:px-12";
// The hero draws its lines in its own ink, faintly, so they recede behind whatever it shows.
const heroLineClassName = "border-current/8";
// From md up, the cells reach this far past the content column on either side, so their outer
// lines frame the hero's copy with the same room the logo and the last link get inside them.
const outsetClassName = "md:-mx-4";
// The header publishes its columns here, on the document, for the hero's lines to follow, and the
// width of its last cell, for the hero item that fits between the lines it draws.
const COLUMNS_PROPERTY = "--landing-header-columns";
const OPEN_WIDTH_PROPERTY = "--landing-header-open-width";

// Once the page scrolls, faint lines in the header's ink frame its cells, over dark surfaces only;
// over light ones the header shows just its items.
const cellSeparatorClassName =
  "border-transparent transition-[color,border-color,background-color] duration-400 ease-out group-data-[scrolled]/header:group-data-[over-dark]/header:border-[color-mix(in_srgb,var(--landing-header-ink)_12%,transparent)]";
const navCellClassName = `flex items-center gap-2 whitespace-nowrap ${cellSeparatorClassName} text-sm font-semibold text-[var(--landing-header-ink)] no-underline outline-none hover:bg-[color-mix(in_srgb,var(--landing-header-ink)_10%,transparent)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:ring-inset`;

/**
 * Whether what shows under the header belongs to one of the page's dark surfaces, the elements
 * marked `data-landing-dark`. It looks at the edge the page scrolls in under: the bottom one going
 * down, the top one going up, so the header turns as soon as a new surface reaches it. It asks for
 * the topmost element there rather than which surface spans it, so the dashboard rising over the
 * hero counts as light. It starts over the hero, which is dark.
 */
function useOverDarkSurface(headerRef: RefObject<HTMLElement | null>) {
  const [overDarkSurface, setOverDarkSurface] = useState(true);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) {
      return undefined;
    }
    let lastScrollY = window.scrollY;
    const updateOverDarkSurface = () => {
      const { top, bottom, left, right } = header.getBoundingClientRect();
      const scrollingUp = window.scrollY < lastScrollY;
      lastScrollY = window.scrollY;
      // Just inside the edge, so the header's own border is not what is asked about.
      const edge = scrollingUp ? top + 1 : bottom - 2;
      const below = document
        .elementsFromPoint((left + right) / 2, edge)
        .find((element) => !header.contains(element));
      setOverDarkSurface(below?.closest("[data-landing-dark]") != null);
    };
    updateOverDarkSurface();
    window.addEventListener("scroll", updateOverDarkSurface, { passive: true });
    window.addEventListener("resize", updateOverDarkSurface);
    return () => {
      window.removeEventListener("scroll", updateOverDarkSurface);
      window.removeEventListener("resize", updateOverDarkSurface);
    };
  }, [headerRef]);
  return overDarkSurface;
}

/** Publishes the widths of the header's logo and link cells, for the hero to line up with. */
function usePublishedColumns() {
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      return undefined;
    }
    const cells = [...grid.querySelectorAll<HTMLElement>("[data-header-cell]")];
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      const [logo, ...links] = cells.map((cell) => `${cell.getBoundingClientRect().width}px`);
      root.style.setProperty(COLUMNS_PROPERTY, `${logo} minmax(0,1fr) ${links.join(" ")}`);
      root.style.setProperty(OPEN_WIDTH_PROPERTY, links.at(-1) ?? "0px");
    });
    cells.forEach((cell) => {
      observer.observe(cell);
    });
    return () => {
      observer.disconnect();
      root.style.removeProperty(COLUMNS_PROPERTY);
      root.style.removeProperty(OPEN_WIDTH_PROPERTY);
    };
  }, []);
  return gridRef;
}

/** Provides the public Leyway product header, Marketplace link, and app entry point. */
export function LandingHeader() {
  const scrolled = useScrolled();
  const gridRef = usePublishedColumns();
  const headerRef = useRef<HTMLElement>(null);
  const overDarkSurface = useOverDarkSurface(headerRef);

  return (
    // Its ink is white over the page's dark surfaces and the page's own ink elsewhere; everything
    // drawn in it fades its own colors from one to the other, which every browser can. Over light
    // surfaces it blurs harder, since busy dark content behind it would otherwise show through.
    <header
      ref={headerRef}
      data-scrolled={scrolled || undefined}
      data-over-dark={overDarkSurface || undefined}
      className="group/header sticky top-0 z-30 border-b border-transparent backdrop-blur-2xl transition-[border-color,backdrop-filter] duration-400 ease-out [--landing-header-ink:var(--bo-fg)] data-[over-dark]:backdrop-blur-md data-[over-dark]:[--landing-header-ink:#fff] data-[scrolled]:border-[color-mix(in_srgb,var(--landing-header-ink)_12%,transparent)]"
    >
      <div className={containerClassName}>
        <div
          ref={gridRef}
          className={`grid h-16 grid-cols-[minmax(0,auto)_minmax(0,1fr)_auto_auto] ${outsetClassName}`}
        >
          <Link
            to="/"
            data-header-cell
            className={`flex min-w-0 items-center border-r pr-4 no-underline outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:ring-inset md:border-l md:pl-4 ${cellSeparatorClassName}`}
            aria-label="Leyway home"
          >
            <LeywayWordmark className="h-9 text-[var(--landing-header-ink)] transition-[color] duration-400 ease-out" />
          </Link>
          <nav aria-label="Product" className="col-span-2 col-start-3 grid grid-cols-subgrid">
            <Link
              to="/marketplace"
              data-header-cell
              className={`${navCellClassName} border-l px-4`}
            >
              Marketplace
            </Link>
            <Link
              to="/backoffice"
              data-header-cell
              className={`${navCellClassName} border-l pl-4 md:border-r md:pr-4`}
            >
              <span className="flex items-center gap-2">
                Open app
                <Icon name="arrow-right" className="size-3.5" />
              </span>
            </Link>
          </nav>
        </div>
      </div>
    </header>
  );
}

/**
 * Lays its children out on the header's columns from md up: the logo's, the free middle, and one
 * per link. Place it across the page's content column. `className` adds to the grid, such as how it
 * lays out below md.
 */
export function LandingColumns({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`md:grid md:grid-cols-[var(--landing-header-columns)] ${outsetClassName} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The header's column lines, continued down the section this fills. Place it under the section's
 * copy and over its artwork, in a `group/hero` that carries `data-scrolled` once the page scrolls.
 */
export function LandingColumnLines() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 hidden opacity-0 transition-opacity duration-300 ease-out group-data-[scrolled]/hero:opacity-100 md:block"
    >
      <div className={`${containerClassName} h-full`}>
        <LandingColumns className="h-full">
          <span className={`border-x ${heroLineClassName}`} />
          <span />
          <span className={`border-l ${heroLineClassName}`} />
          <span className={`border-x ${heroLineClassName}`} />
        </LandingColumns>
      </div>
    </div>
  );
}
