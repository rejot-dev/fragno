import { useSearchContext } from "fumadocs-ui/contexts/search";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { Search } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Link, Outlet, useLocation } from "react-router";

import { baseOptions } from "@/lib/layout.shared";

const mono =
  'font-mono [font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation_Mono",monospace]';

function SearchBar() {
  const { enabled, hotKey, setOpenSearch } = useSearchContext();
  if (!enabled) {
    return null;
  }

  const hotkeyParts = hotKey.slice(0, 2);

  return (
    <button
      type="button"
      onClick={() => setOpenSearch(true)}
      className="inline-flex items-center gap-2 bg-[color-mix(in_srgb,var(--editorial-surface)_75%,transparent)] px-3 py-1.5 text-base shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] backdrop-blur-[12px]"
      aria-label="Open Search"
      data-search
    >
      <Search className="size-4" />
      <span className="hidden sm:inline">Search docs</span>
      <kbd
        className={`${mono} inline-flex items-center justify-center bg-[color-mix(in_srgb,var(--editorial-surface)_70%,transparent)] px-2 py-1 text-base font-medium shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]`}
      >
        {hotkeyParts.map((k, idx) => (
          <span key={typeof k.key === "string" ? k.key : "mod"} className={idx === 0 ? "" : "ms-1"}>
            {k.display}
          </span>
        ))}
      </kbd>
    </button>
  );
}

function HeaderTitle() {
  return (
    <span className="inline-flex items-center gap-2 no-underline" aria-label="Fragno home">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--editorial-primary)]"
        aria-hidden
      />
      <span className={`${mono} text-[0.78rem] font-semibold tracking-[0.04em]`}>Fragno</span>
    </span>
  );
}

export default function Layout({ children }: { children?: ReactNode }) {
  const { pathname } = useLocation();
  const isDocsPage = pathname === "/docs" || pathname.startsWith("/docs/");
  const showPageRoad =
    pathname === "/" ||
    pathname === "/fragments/resend/essay" ||
    /^\/blog\/[^/]+\/?$/.test(pathname);

  return (
    <HomeLayoutWithFooter isDocsPage={isDocsPage} showPageRoad={showPageRoad}>
      {children}
    </HomeLayoutWithFooter>
  );
}

export function HomeLayoutWithFooter({
  children,
  isDocsPage,
  showPageRoad,
}: {
  children?: ReactNode;
  isDocsPage: boolean;
  showPageRoad: boolean;
}) {
  const options = baseOptions();
  const headerLinks = [
    {
      type: "main",
      on: "all",
      url: "/fragments",
      text: "FRAGMENTS",
    },
    {
      type: "main",
      on: "all",
      url: "/blog",
      text: "BLOG",
    },

    {
      type: "main",
      on: "all",
      url: "/docs",
      text: "DOCS",
    },
    {
      type: "icon",
      url: "https://github.com/rejot-dev/fragno",
      text: "GITHUB",
      label: "GITHUB",
      icon: (
        <span className={`${mono} text-[0.72rem] font-semibold tracking-[0.08em]`}>GITHUB</span>
      ),
      external: true,
    },
    {
      type: "icon",
      url: "https://discord.gg/jdXZxyGCnC",
      text: "DISCORD",
      label: "DISCORD",
      icon: (
        <span className={`${mono} text-[0.72rem] font-semibold tracking-[0.08em]`}>DISCORD</span>
      ),
      external: true,
    },
  ] satisfies ComponentProps<typeof HomeLayout>["links"];

  return (
    <div className="relative min-h-screen">
      {showPageRoad ? <div aria-hidden className="editorial-page-road" /> : null}
      <HomeLayout
        {...options}
        searchToggle={{
          components: {
            lg: <SearchBar />,
          },
        }}
        themeSwitch={{
          enabled: false,
        }}
        nav={{
          ...options.nav,
          title: <HeaderTitle />,
        }}
        links={headerLinks}
      >
        {children ?? <Outlet />}
        <Footer isDocsPage={isDocsPage} />
      </HomeLayout>
    </div>
  );
}

export function Footer({ isDocsPage }: { isDocsPage: boolean }) {
  return (
    <footer
      className={`mt-20 bg-[color-mix(in_srgb,var(--editorial-surface)_72%,transparent)] backdrop-blur-[10px] ${isDocsPage ? "md:pl-[268px] lg:pl-[286px]" : ""}`}
    >
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-[1.3fr_0.7fr_0.7fr]">
          <div className="space-y-6">
            <Link
              to="/"
              className="inline-flex items-center gap-2 no-underline"
              aria-label="Fragno home"
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--editorial-primary)]"
                aria-hidden
              />
              <span className={`${mono} text-[0.78rem] font-semibold tracking-[0.04em]`}>
                Fragno by ReJot
              </span>
            </Link>
            <p className={`${mono} max-w-xs text-[var(--editorial-muted)]`}>
              Ship full-stack vertical slices that work seamlessly across frameworks.
            </p>
          </div>

          <div>
            <h3
              className={`${mono} text-base font-bold tracking-[0.18em] text-[var(--editorial-muted)] uppercase`}
            >
              Connect
            </h3>
            <ul className={`${mono} mt-5 space-y-3 text-base tracking-[0.08em] uppercase`}>
              <li>
                <a href="https://github.com/rejot-dev/fragno" target="_blank" rel="noreferrer">
                  GitHub
                </a>
              </li>
              <li>
                <a href="https://x.com/wilcokr" target="_blank" rel="noreferrer">
                  X
                </a>
              </li>
              <li>
                <a href="https://discord.gg/jdXZxyGCnC" target="_blank" rel="noreferrer">
                  Discord
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h3
              className={`${mono} text-base font-bold tracking-[0.18em] text-[var(--editorial-muted)] uppercase`}
            >
              Reference
            </h3>
            <ul className={`${mono} mt-5 space-y-3 text-base tracking-[0.08em] uppercase`}>
              <li>
                <Link to="/fragments">Fragments</Link>
              </li>
              <li>
                <Link to="/docs">Documentation</Link>
              </li>
              <li>
                <Link to="/blog">Blog</Link>
              </li>
            </ul>
          </div>
        </div>

        <div
          className={`${mono} mt-14 flex flex-col gap-4 pt-8 text-base tracking-[0.18em] text-[var(--editorial-muted)] uppercase md:flex-row md:items-center md:justify-between`}
        >
          <p>© 2026 ReJot </p>
          <div className="flex gap-2" aria-hidden>
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--editorial-primary)]" />
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--editorial-secondary)]" />
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--editorial-tertiary)]" />
          </div>
        </div>
      </div>
    </footer>
  );
}
