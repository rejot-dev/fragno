import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";
import Link from "next/link";
import { Book, BookOpenText, Mail } from "lucide-react";
import { GitHub } from "@/components/logos/github";
import { FragnoCircle } from "@/components/logos/fragno-circle";

import { defaultMetadata } from "@/lib/metadata";

export const metadata = {
  ...defaultMetadata,
  title: {
    template: "%s | Fragno Blog",
    default: "Fragno",
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
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
          icon: <GitHub className="size-4" />,
          external: true,
        },
      ]}
    >
      {" "}
      {children} <Footer />
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
              href="/"
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
                  href="/"
                  className="text-sm text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                >
                  Home
                </Link>
              </li>
              <li>
                <Link
                  href="/docs/fragno"
                  className="text-sm text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                >
                  Docs
                </Link>
              </li>
              <li>
                <Link
                  href="/blog"
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
