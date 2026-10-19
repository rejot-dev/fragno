import type { CSSProperties, ReactNode } from "react";

/** The app a sign-in page speaks for. */
export type AppAuthBrand = {
  name: string;
  logoUrl: string;
  accentColor: string;
  homeUrl: string;
  supportUrl: string;
};

/**
 * A sign-in page in an app's name: its logo, name, and color, a single card, and a quiet "Secured by
 * ReJot" footer. People an app sends here may not know Backoffice, so nothing else names it. The
 * accent replaces the theme's call-to-action color, so `solid` buttons and links take it.
 */
export function AppAuthLayout({
  brand,
  title,
  description,
  children,
}: {
  brand: AppAuthBrand;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  const accent = {
    "--bo-accent": brand.accentColor,
    "--bo-btn-bg": brand.accentColor,
    "--bo-btn-bg-hover": `color-mix(in srgb, ${brand.accentColor} 82%, black)`,
    "--bo-btn-fg": "#ffffff",
  } as CSSProperties;
  return (
    <div
      data-backoffice-root
      style={accent}
      className="flex min-h-screen flex-col items-center bg-[var(--bo-bg)] px-4 py-10 text-[var(--bo-fg)] sm:py-16"
    >
      <a
        href={brand.homeUrl}
        className="flex items-center gap-3 rounded-[4px] no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--bo-accent)]"
      >
        <img src={brand.logoUrl} alt="" width={40} height={40} className="size-10 rounded-[8px]" />
        <span className="text-xl font-semibold text-[var(--bo-fg)]">{brand.name}</span>
      </a>
      <main className="mt-8 w-full max-w-sm rounded-[6px] border border-[var(--bo-border)] bg-[var(--bo-panel)] p-6 shadow-[var(--bo-selected-shadow)] sm:p-8">
        <h1 className="text-2xl font-semibold text-balance">{title}</h1>
        <div className="mt-2 text-sm leading-6 text-pretty text-[var(--bo-muted)]">
          {description}
        </div>
        <div className="mt-6">{children}</div>
      </main>
      <footer className="mt-6 flex w-full max-w-sm flex-wrap items-center justify-between gap-2 text-xs text-[var(--bo-muted)]">
        <a
          href={brand.supportUrl}
          className="text-[var(--bo-accent)] underline-offset-4 hover:underline"
        >
          Need help?
        </a>
        <span>Secured by ReJot</span>
      </footer>
    </div>
  );
}
