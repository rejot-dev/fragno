import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";
import { Link, Outlet, useLocation } from "react-router";
import { Mail } from "lucide-react";
import { FragnoCircle } from "@/components/logos/fragno-circle";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import { Search } from "fumadocs-ui/internal/icons";
import type { ReactNode } from "react";

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
      className="border-fd-border/70 bg-fd-background/55 text-fd-muted-foreground hover:bg-fd-accent/35 hover:text-fd-accent-foreground focus-visible:ring-fd-ring fixed left-1/2 z-50 inline-flex -translate-x-1/2 items-center gap-2 space-x-6 rounded-full border px-3 py-1.5 text-sm shadow-sm backdrop-blur-md transition-colors focus-visible:outline-none focus-visible:ring-2"
      aria-label="Open Search"
      data-search
    >
      <Search className="size-4" />
      <span className="text-fd-muted-foreground hidden sm:inline">Search Docs</span>
      <kbd className="bg-fd-background/70 text-fd-muted-foreground ring-fd-border inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium leading-none ring-1">
        {hotkeyParts.map((k, idx) => (
          <span key={typeof k.key === "string" ? k.key : "mod"} className={idx === 0 ? "" : "ms-1"}>
            {k.display}
          </span>
        ))}
      </kbd>
    </button>
  );
}

export default function Layout({ children }: { children?: ReactNode }) {
  const { pathname } = useLocation();
  const isDocsPage = pathname.startsWith("/docs/");

  return <HomeLayoutWithFooter isDocsPage={isDocsPage}>{children}</HomeLayoutWithFooter>;
}

export function HomeLayoutWithFooter({
  children,
  isDocsPage,
}: {
  children?: ReactNode;
  isDocsPage: boolean;
}) {
  const options = baseOptions();

  return (
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
        title: (
          <div className="flex items-center gap-2">
            <span className="relative">
              <span
                aria-hidden
                className="bg-linear-to-br pointer-events-none absolute inset-0 -z-10 rounded-full from-blue-500/25 via-sky-400/20 to-purple-500/25 blur-md"
              />
              <FragnoCircle className="size-8" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">Fragno</span>
          </div>
        ),
      }}
      links={[
        {
          type: "main",
          on: "all",
          url: "/fragments",
          text: "Fragments",
        },
        {
          type: "main",
          on: "all",
          url: "/authors",
          text: "For Authors",
        },
        {
          type: "main",
          on: "all",
          url: "/docs",
          text: "Docs",
        },
        {
          type: "main",
          on: "all",
          url: "/blog",
          text: "Blog",
        },
        {
          type: "custom",
          on: "nav",
          secondary: true,
          children: (
            <div className="flex items-center gap-2 pe-2 max-sm:hidden">
              <a
                href="https://github.com/rejot-dev/fragno"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
                className="text-fd-foreground/70 hover:bg-fd-accent/55 hover:text-fd-foreground focus-visible:ring-fd-ring inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2"
              >
                <svg role="img" viewBox="0 0 24 24" fill="currentColor" className="size-6">
                  <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                </svg>
              </a>
              <a
                href="https://discord.gg/jdXZxyGCnC"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Discord"
                className="text-fd-foreground/70 hover:bg-fd-accent/55 hover:text-fd-foreground focus-visible:ring-fd-ring inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2"
              >
                <svg role="img" viewBox="0 0 24 24" fill="currentColor" className="size-6">
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
              </a>
            </div>
          ),
        },
        {
          type: "icon",
          url: "https://github.com/rejot-dev/fragno",
          text: "GitHub",
          label: "GitHub",
          icon: (
            <svg role="img" viewBox="0 0 24 24" fill="currentColor" className="size-4">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
          ),
          external: true,
          on: "menu",
        },
        {
          type: "icon",
          url: "https://discord.gg/jdXZxyGCnC",
          text: "Discord",
          label: "Discord",
          icon: (
            <svg role="img" viewBox="0 0 24 24" fill="currentColor" className="size-4">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
            </svg>
          ),
          external: true,
          on: "menu",
        },
      ]}
    >
      {children ?? <Outlet />}
      <Footer isDocsPage={isDocsPage} />
    </HomeLayout>
  );
}

export function Footer({ isDocsPage }: { isDocsPage: boolean }) {
  return (
    <footer
      className={`border-t border-gray-200/50 bg-white/50 shadow-sm dark:border-white/10 dark:bg-slate-950/50 ${
        // On docs pages, the sidebar is fixed on the left on desktop.
        // Offset the *footer wrapper* so the inner content can stay centered.
        isDocsPage ? "md:pl-[268px] lg:pl-[286px]" : ""
      }`}
    >
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {/* Logo and description */}
          <div className="col-span-1 sm:col-span-2 lg:col-span-1">
            <Link
              to="/"
              className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-gray-100"
            >
              <FragnoCircle className="size-12" />
              <span>Fragno</span>
            </Link>
            <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
              Build framework-agnostic full-stack libraries
            </p>
          </div>

          {/* Product */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Product</h3>
            <ul className="mt-4 space-y-3">
              <li>
                <Link
                  to="/"
                  className="text-sm text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                >
                  Home
                </Link>
              </li>
              <li>
                <Link
                  to="/fragments"
                  className="text-sm text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                >
                  Fragments
                </Link>
              </li>
              <li>
                <Link
                  to="/authors"
                  className="text-sm text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                >
                  For Authors
                </Link>
              </li>
              <li>
                <Link
                  to="/docs/fragno"
                  className="text-sm text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                >
                  Docs
                </Link>
              </li>
              <li>
                <Link
                  to="/blog"
                  className="text-sm text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                >
                  Blog
                </Link>
              </li>
            </ul>
          </div>

          {/* Developer */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Developer</h3>
            <ul className="mt-4 space-y-3">
              <li>
                <a
                  href="https://github.com/rejot-dev/fragno"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                >
                  GitHub ↗
                </a>
              </li>
              <li>
                <a
                  href="https://discord.gg/jdXZxyGCnC"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                >
                  Discord ↗
                </a>
              </li>
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Company</h3>
            <ul className="mt-4 space-y-3">
              <li>
                <a
                  href="mailto:fragno@rejot.dev"
                  className="flex items-center gap-2 text-sm text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                >
                  Contact
                  <Mail className="h-4 w-4" />
                </a>
              </li>
              <li>
                <a
                  href="https://rejot.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                >
                  ReJot ↗
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-8 border-t border-gray-200/50 pt-8 dark:border-white/10">
          <p className="text-center text-sm text-gray-500 dark:text-gray-400">
            Fragno by{" "}
            <a
              href="https://rejot.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              ReJot
            </a>
            . With ❤️ from Amsterdam
          </p>
        </div>
      </div>
    </footer>
  );
}
