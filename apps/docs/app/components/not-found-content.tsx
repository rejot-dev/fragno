import { BookOpen, Home } from "lucide-react";
import { Link } from "react-router";

import {
  FragmentActionLink,
  FragmentEyebrow,
  FragmentPageShell,
  FragmentPanel,
} from "@/components/fragment-editorial";

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
  const resolvedDetails = is404
    ? (details ?? "The requested page could not be found.")
    : (details ?? "An unexpected error occurred.");

  return (
    <FragmentPageShell
      mainClassName="flex min-h-[max(12rem,calc(100dvh-19rem))] flex-col"
      className="flex min-h-0 flex-1 flex-col justify-center py-8 sm:py-10 md:py-12 lg:py-12"
    >
      <div className="flex flex-col items-center justify-center pb-2">
        <div className="mx-auto w-full max-w-2xl space-y-6 text-center">
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-(--editorial-primary)"
                aria-hidden
              />
              <FragmentEyebrow colorClass="text-(--editorial-primary)">
                {is404 ? "Not found" : "Something went wrong"}
              </FragmentEyebrow>
            </div>
            <h1 className="bg-linear-to-br from-(--editorial-ink) from-40% via-(--editorial-ink) to-[color-mix(in_srgb,var(--editorial-primary)_88%,var(--editorial-ink))] bg-clip-text text-6xl leading-[0.92] font-bold tracking-[-0.06em] text-transparent md:text-8xl">
              {message}
            </h1>
            <p className="mx-auto max-w-lg text-base leading-[1.75] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)] md:text-lg">
              {resolvedDetails}
            </p>
          </div>

          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
            <FragmentActionLink to="/" variant="primary">
              <Home className="size-4 shrink-0" aria-hidden />
              Back to home
            </FragmentActionLink>
            <FragmentActionLink to="/docs" variant="secondary">
              <BookOpen className="size-4 shrink-0" aria-hidden />
              Documentation
            </FragmentActionLink>
          </div>

          {is404 ? (
            <p className="text-sm leading-relaxed text-(--editorial-muted)">
              Try the search in the header, or browse the{" "}
              <Link
                to="/docs"
                className="font-semibold text-(--editorial-ink) underline decoration-[color-mix(in_srgb,var(--editorial-ink)_35%,transparent)] underline-offset-4 transition-colors hover:decoration-(--editorial-primary)"
              >
                docs
              </Link>
              .
            </p>
          ) : null}

          {stack ? (
            <div className="w-full max-w-3xl pt-4 text-left">
              <FragmentPanel className="border-[color-mix(in_srgb,var(--destructive)_45%,transparent)] bg-[color-mix(in_srgb,var(--destructive)_6%,transparent)] p-0 dark:bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)]">
                <details className="group">
                  <summary
                    className={`cursor-pointer px-4 py-3 text-sm font-semibold tracking-[0.08em] text-(--destructive) uppercase`}
                  >
                    Stack trace (dev only)
                  </summary>
                  <pre className="overflow-x-auto border-t border-[color-mix(in_srgb,var(--destructive)_35%,transparent)] p-4 text-xs leading-relaxed text-[color-mix(in_srgb,var(--editorial-ink)_88%,var(--destructive))]">
                    <code>{stack}</code>
                  </pre>
                </details>
              </FragmentPanel>
            </div>
          ) : null}
        </div>
      </div>
    </FragmentPageShell>
  );
}
