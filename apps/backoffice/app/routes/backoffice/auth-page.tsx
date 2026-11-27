import {
  PillArrow,
  PillButton,
  PillButtonLink,
  PillLabel,
} from "@fragno-private/design-system/controls/pill-button";
import { LandingHeroPhotoPlaceholder } from "@fragno-private/design-system/landing/hero-photo";
import type { ReactNode } from "react";

import { LandingFooter } from "../landing/landing-footer";
import { LandingHeader } from "../landing/landing-header";

export const INK_LINK_CLASS_NAME =
  "font-semibold text-[var(--bo-fg)] underline decoration-[color-mix(in_srgb,var(--bo-fg)_30%,transparent)] underline-offset-4 transition-[text-decoration-color] duration-150 hover:decoration-current";

const CARD_TITLE_ID = "auth-card-title";

/** GitHub's official mark, `mark-github` from Primer Octicons (MIT). */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4.5" fill="currentColor">
      <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
    </svg>
  );
}

/** An outlined pill that starts GitHub authentication, with GitHub's mark at its end. */
export function GitHubButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <PillButton
      variant="outlined"
      size="default"
      ring={false}
      onClick={onClick}
      disabled={disabled}
      className="relative w-full"
    >
      <PillLabel>{label}</PillLabel>
      {/* At the pill's end, like the button inside the marketplace's search pill, so the label
          stays centered with the other pills'. */}
      <span className="absolute top-1/2 right-1.5 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-[#0b0b0a] text-white">
        <GitHubMark />
      </span>
    </PillButton>
  );
}

/** Separates a password form from the other way in. */
export function OrDivider() {
  return (
    <div className="flex items-center gap-3 pt-2 text-xs text-[var(--bo-muted-2)]" role="separator">
      <span className="h-px flex-1 bg-[var(--bo-border)]" aria-hidden="true" />
      <span>Or</span>
      <span className="h-px flex-1 bg-[var(--bo-border)]" aria-hidden="true" />
    </div>
  );
}

/** A problem that stops authentication, with what to do about it. */
export function AuthAlert({ title, message }: { title: string; message: string }) {
  return (
    <div role="alert" className="border-l-2 border-red-500 bg-red-500/5 px-3 py-3 text-pretty">
      <p className="text-sm font-semibold text-red-600">{title}</p>
      <p className="mt-1 text-xs leading-5 text-red-600/90">{message}</p>
    </div>
  );
}

/** The other way in, signing in or signing up, offered at the bottom of the card. */
type AuthAlternative = { title: string; description: string; label: string; to: string };

/**
 * The page people sign in and sign up on: the landing header with only the way home, the
 * homepage's hero film behind the copy, and a card holding `children`, the page's form, under its
 * `title` and `description`. `alternative` is null while the page has nothing else to offer.
 */
export function AuthPage({
  title,
  description,
  alternative,
  children,
}: {
  title: string;
  description: string;
  alternative: AuthAlternative | null;
  children: ReactNode;
}) {
  return (
    <div
      data-backoffice-root
      className="flex min-h-svh flex-col bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <LandingHeader startsOverDark={true} nav="back-home" />
      {/* The homepage's hero film over the hero photo's colors, as on the marketplace, filling the
          screen behind the header and padded back down by its height and border. */}
      <section
        data-landing-dark
        className="relative -mt-[calc(var(--spacing)*16+1px)] flex min-h-svh overflow-hidden bg-[#232322] pt-[calc(var(--spacing)*16+1px)] text-white"
      >
        <div aria-hidden="true" className="landing-film-mono">
          <LandingHeroPhotoPlaceholder photo="fitz-roy" />
        </div>
        {/* Padded at the bottom by the header's height too, so the copy and form center on the
            screen rather than on the part of it below the header. */}
        <div className="max-w-landing relative z-10 mx-auto grid w-full items-center gap-12 px-7 pt-8 pb-[calc(2rem+var(--spacing)*16+1px)] sm:px-8 lg:grid-cols-[minmax(0,1fr)_28rem] lg:px-12">
          {/* Indented slightly: the logo's mark ends in a point on its left, so aligned to the
              pixel the copy reads as sitting left of it. */}
          <div className="hidden pl-4 lg:block">
            <h1 className="font-heading text-[clamp(2.25rem,4vw,3.5rem)] leading-[1.05] font-light tracking-[-0.02em]">
              What are we
              <br />
              building today?
            </h1>
            <p className="mt-6 max-w-md text-lg leading-7 text-pretty text-white/85">
              Describe how your business runs. Leyway turns it into workflows that run the same way
              every time, ask before they act, and record every step.
            </p>
          </div>

          <section
            aria-labelledby={CARD_TITLE_ID}
            className="w-full overflow-hidden rounded-[14px] bg-[var(--bo-panel)] text-[var(--bo-fg)] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.5)]"
          >
            <div className="p-6 sm:p-8">
              <h2
                id={CARD_TITLE_ID}
                className="font-heading text-3xl font-light tracking-[-0.02em] text-balance"
              >
                {title}
              </h2>
              <p className="mt-2 text-sm leading-6 text-pretty text-[var(--bo-muted)]">
                {description}
              </p>
              <div className="mt-6 space-y-4">{children}</div>
            </div>
            {alternative ? (
              // The other way in gets its own tinted part of the card rather than a line under
              // the form.
              <div className="border-t border-[color:var(--bo-border)] bg-[color-mix(in_srgb,var(--bo-fg)_4%,var(--bo-panel))] p-6 sm:px-8">
                <h3 className="font-heading text-xl font-light tracking-[-0.01em]">
                  {alternative.title}
                </h3>
                <p className="mt-1 text-sm leading-6 text-[var(--bo-muted)]">
                  {alternative.description}
                </p>
                <PillButtonLink
                  to={alternative.to}
                  variant="outlined"
                  size="default"
                  ring={false}
                  className="mt-4 w-full bg-[var(--bo-panel)]"
                >
                  <PillLabel>{alternative.label}</PillLabel>
                  <PillArrow />
                </PillButtonLink>
              </div>
            ) : null}
          </section>
        </div>
      </section>
      <LandingFooter />
    </div>
  );
}
