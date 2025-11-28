import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";
import { Link, Outlet } from "react-router";
import { Book, BookOpenText, Mail } from "lucide-react";
import { FragnoCircle } from "@/components/logos/fragno-circle";

export default function HomeLayoutWithFooter() {
  return (
    <HomeLayout
      {...baseOptions()}
      links={[
        {
          text: "Documentation",
          url: "/docs",
          icon: <Book />,
        },
        {
          text: "Blog",
          url: "/blog",
          icon: <BookOpenText />,
        },
        {
          type: "icon",
          url: "https://github.com/rejot-dev/fragno",
          text: "GitHub",
          icon: (
            <svg role="img" viewBox="0 0 24 24" fill="currentColor" className="size-4">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
          ),
          external: true,
        },
      ]}
    >
      <Outlet />
      <Footer />
    </HomeLayout>
  );
}

function Footer() {
  return (
    <footer className="border-t border-gray-200/50 bg-white/50 shadow-sm dark:border-white/10 dark:bg-slate-950/50">
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
