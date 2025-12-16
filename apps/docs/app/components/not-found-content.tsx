import { Link } from "react-router";
import { Home, BookOpen } from "lucide-react";

type NotFoundContentProps = {
  message?: string;
  details?: string;
  stack?: string;
  is404?: boolean;
};

export function NotFoundContent({
  message = "404",
  details,
  stack,
  is404 = true,
}: NotFoundContentProps) {
  return (
    <div className="flex min-h-[calc(100vh-256px)] flex-col">
      {/* Main content */}
      <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-4 py-16">
        {/* Main content card */}
        <div className="relative flex flex-col items-center">
          {/* Error code with gradient text */}
          <h1 className="bg-linear-to-r from-indigo-600 via-purple-600 to-sky-600 bg-clip-text text-8xl font-black tracking-tighter text-transparent md:text-9xl dark:from-indigo-400 dark:via-purple-400 dark:to-sky-400">
            {message}
          </h1>

          {/* Description */}
          <p className="text-fd-muted-foreground mt-4 max-w-md text-center text-lg md:text-xl">
            {is404 ? "<Insert AI generated 404 message here>" : details}
          </p>

          {/* Action buttons */}
          <div className="mt-10 flex flex-col gap-4 sm:flex-row">
            <Link
              to="/"
              className="group inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:-translate-y-0.5 hover:bg-indigo-700 hover:shadow-xl hover:shadow-indigo-500/30"
            >
              <Home className="size-5 transition-transform group-hover:-translate-x-0.5" />
              Back to Home
            </Link>
            <Link
              to="/docs/fragno"
              className="group inline-flex items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white/80 px-6 py-3 font-semibold text-gray-700 shadow-sm backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:border-gray-400 hover:bg-white hover:shadow-md dark:border-white/20 dark:bg-white/5 dark:text-gray-200 dark:hover:border-white/30 dark:hover:bg-white/10"
            >
              <BookOpen className="size-5 transition-transform group-hover:scale-105" />
              View Docs
            </Link>
          </div>

          {/* Helpful suggestion */}
          {is404 && (
            <div className="mt-12 text-center">
              <p className="text-fd-muted-foreground text-sm">
                Looking for something specific? Try using the search or check out our{" "}
                <Link
                  to="/docs/fragno"
                  className="font-medium text-indigo-600 underline-offset-4 hover:underline dark:text-indigo-400"
                >
                  documentation
                </Link>
                .
              </p>
            </div>
          )}

          {/* Dev stack trace */}
          {stack && (
            <div className="mt-12 w-full max-w-3xl">
              <details className="group rounded-xl border border-red-200 bg-red-50/50 dark:border-red-500/20 dark:bg-red-950/20">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-red-700 dark:text-red-400">
                  Stack trace (dev only)
                </summary>
                <pre className="overflow-x-auto border-t border-red-200 p-4 text-xs text-red-600 dark:border-red-500/20 dark:text-red-400">
                  <code>{stack}</code>
                </pre>
              </details>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
