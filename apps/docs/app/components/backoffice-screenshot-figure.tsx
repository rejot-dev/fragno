import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

export type BackofficeScreenshotFigureProps = {
  screenshotUrl: {
    light: string;
    dark: string;
  };
  caption: ReactNode;
};

export function BackofficeScreenshotFigure({
  screenshotUrl,
  caption,
}: BackofficeScreenshotFigureProps) {
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!fullscreenOpen) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFullscreenOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreenOpen]);

  const overlay =
    fullscreenOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="fixed inset-0 z-200 flex items-center justify-center p-2 sm:p-4"
          >
            <button
              type="button"
              className="absolute inset-0 bg-[rgb(15_23_42/0.88)] backdrop-blur-[2px] dark:bg-[rgb(2_6_23/0.94)]"
              onClick={() => setFullscreenOpen(false)}
              aria-label="Close fullscreen view"
            />
            <div className="relative z-10 flex max-h-[min(96dvh,96vh)] w-[96vw] max-w-[min(1800px,96vw)] flex-col">
              <div className="sr-only" id={titleId}>
                Backoffice screenshot
              </div>
              <button
                type="button"
                onClick={() => setFullscreenOpen(false)}
                className="absolute top-2 right-2 z-20 inline-flex size-10 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--editorial-surface)_92%,transparent)] text-(--editorial-ink) shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-surface)_88%,var(--editorial-ink)_6%)]"
                aria-label="Close"
              >
                <X className="size-5" strokeWidth={2} aria-hidden />
              </button>
              <div className="overflow-auto rounded-lg shadow-[0_24px_80px_rgb(0_0_0/0.45)]">
                <img
                  src={screenshotUrl.light}
                  alt=""
                  className="block max-h-[min(94dvh,94vh)] w-full object-contain object-top dark:hidden"
                />
                <img
                  src={screenshotUrl.dark}
                  alt=""
                  className="hidden max-h-[min(94dvh,94vh)] w-full object-contain object-top dark:block"
                />
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <figure className="space-y-6">
        <div className="overflow-hidden bg-[color-mix(in_srgb,var(--editorial-surface)_84%,transparent)] shadow-[0_24px_48px_rgb(15_23_42/0.08)] backdrop-blur-md dark:shadow-[0_24px_48px_rgb(2_6_23/0.28)]">
          <button
            type="button"
            onClick={() => setFullscreenOpen(true)}
            className="group relative block w-full cursor-zoom-in border-0 bg-transparent p-0 text-left"
            aria-label="View backoffice screenshot fullscreen"
          >
            <img
              src={screenshotUrl.light}
              alt="Backoffice UI using Fragno fragments (light)"
              className="block w-full dark:hidden"
            />
            <img
              src={screenshotUrl.dark}
              alt="Backoffice UI using Fragno fragments (dark)"
              className="hidden w-full dark:block"
            />
            <span
              className="pointer-events-none absolute inset-0 bg-[rgb(15_23_42/0)] transition-colors group-hover:bg-[rgb(15_23_42/0.06)] group-focus-visible:bg-[rgb(15_23_42/0.08)] group-focus-visible:ring-2 group-focus-visible:ring-(--editorial-primary) group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-[color-mix(in_srgb,var(--editorial-surface)_84%,transparent)] dark:group-hover:bg-[rgb(2_6_23/0.2)] dark:group-focus-visible:ring-offset-[color-mix(in_srgb,var(--editorial-surface)_84%,transparent)]"
              aria-hidden
            />
          </button>
        </div>
        <figcaption className="max-w-4xl text-base font-medium text-(--editorial-muted)">
          {caption}
        </figcaption>
      </figure>
      {overlay}
    </>
  );
}
