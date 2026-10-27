import { Icon } from "@fragno-private/design-system/icon";
import { LooppWordmark } from "@fragno-private/design-system/loopp-wordmark";
import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router";

import { useScrolled } from "./use-scrolled";

// Mirrors the cells of the app's top bar, aligned to the page's content column. Every cell hugs
// its item with the same padding. Once the page scrolls under the header, lines frame the cells and
// the hero continues them downward; from md up, the hero's lines follow the cells' measured widths.
const containerClassName = "mx-auto w-full max-w-[1180px] px-5 sm:px-8 lg:px-12";
// The hero draws its lines in its own ink, faintly, so they recede behind whatever it shows.
const heroLineClassName = "border-current/15";
// From md up, the cells reach this far past the content column on either side, so their outer
// lines frame the hero's copy with the same room the logo and the last link get inside them.
const outsetClassName = "md:-mx-4";
// The header publishes its columns here, on the document, for the hero's lines to follow, and the
// widths of its first and last cells, for hero items that fit between the lines it draws.
const COLUMNS_PROPERTY = "--landing-header-columns";
const LOGO_WIDTH_PROPERTY = "--landing-header-logo-width";
const OPEN_WIDTH_PROPERTY = "--landing-header-open-width";

const cellSeparatorClassName =
  "border-transparent transition-colors duration-150 ease-out group-data-[scrolled]/header:border-[color:var(--bo-border)]";
const navCellClassName = `flex items-center gap-2 whitespace-nowrap ${cellSeparatorClassName} text-sm font-semibold text-[var(--bo-fg)] no-underline outline-none hover:bg-[var(--bo-panel-2)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:ring-inset`;

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
      root.style.setProperty(LOGO_WIDTH_PROPERTY, logo);
      root.style.setProperty(OPEN_WIDTH_PROPERTY, links.at(-1) ?? "0px");
    });
    cells.forEach((cell) => {
      observer.observe(cell);
    });
    return () => {
      observer.disconnect();
      root.style.removeProperty(COLUMNS_PROPERTY);
      root.style.removeProperty(LOGO_WIDTH_PROPERTY);
      root.style.removeProperty(OPEN_WIDTH_PROPERTY);
    };
  }, []);
  return gridRef;
}

/** Provides the public Loopp product header, Marketplace link, and app entry point. */
export function LandingHeader() {
  const scrolled = useScrolled();
  const gridRef = usePublishedColumns();

  return (
    <header
      data-scrolled={scrolled || undefined}
      className="group/header sticky top-0 z-30 border-b border-transparent bg-[color:var(--bo-top-bar-bg)] transition-colors duration-150 ease-out data-[scrolled]:border-[color:var(--bo-border)]"
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
            aria-label="Loopp home"
          >
            <span className="flex shrink-0 items-center gap-2.5">
              <LooppWordmark className="h-7 text-[var(--bo-fg)]" animated />
              <span className="loopp-wordmark-after mt-1.5 text-[10px] font-semibold whitespace-nowrap text-[var(--bo-muted-2)]">
                by ReJot
              </span>
            </span>
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
