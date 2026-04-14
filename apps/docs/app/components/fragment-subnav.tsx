import { Link } from "react-router";

import { cn } from "@/lib/cn";

const fragments = [
  {
    id: "stripe",
    label: "Stripe",
    href: "/fragments/stripe",
    dot: "bg-[var(--editorial-muted)]/60",
  },
  {
    id: "telegram",
    label: "Telegram",
    href: "/fragments/telegram",
    dot: "bg-[var(--editorial-muted)]/60",
  },
  { id: "forms", label: "Forms", href: "/fragments/forms", dot: "bg-[var(--editorial-muted)]/60" },
  {
    id: "workflows",
    label: "Workflows",
    href: "/fragments/workflows",
    dot: "bg-[var(--editorial-muted)]/60",
  },
  { id: "pi", label: "Pi", href: "/fragments/pi", dot: "bg-[var(--editorial-muted)]/60" },
  {
    id: "resend",
    label: "Resend",
    href: "/fragments/resend",
    dot: "bg-[var(--editorial-muted)]/60",
  },
  {
    id: "github",
    label: "GitHub",
    href: "/fragments/github",
    dot: "bg-[var(--editorial-muted)]/60",
  },
  {
    id: "upload",
    label: "Uploads",
    href: "/fragments/upload",
    dot: "bg-[var(--editorial-muted)]/60",
  },
  { id: "auth", label: "Auth", href: "/fragments/auth", dot: "bg-[var(--editorial-muted)]/60" },
] as const;

type FragmentId = (typeof fragments)[number]["id"];

export function FragmentSubnav({
  current,
  className,
}: {
  current: FragmentId;
  className?: string;
}) {
  return (
    <nav
      aria-label="Fragment navigation"
      className={cn(
        "mb-12 flex flex-wrap items-center gap-2 text-[11px] font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase",
        className,
      )}
    >
      <Link
        to="/fragments"
        className="bg-[color-mix(in_srgb,var(--editorial-surface)_78%,transparent)] px-3 py-1.5 shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] backdrop-blur-[12px] transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-ink)_4%,transparent)] hover:text-[var(--editorial-ink)]"
      >
        First party fragments
      </Link>
      {fragments.map((fragment) => {
        const content = (
          <>
            <span className={`h-1.5 w-1.5 rounded-full ${fragment.dot}`} aria-hidden />
            <span>{fragment.label}</span>
          </>
        );

        if (fragment.id === current) {
          return (
            <span
              key={fragment.id}
              aria-current="page"
              className="inline-flex items-center gap-2 bg-[color-mix(in_srgb,var(--editorial-surface)_84%,transparent)] px-3 py-1.5 text-[var(--editorial-ink)] shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] backdrop-blur-[12px]"
            >
              {content}
            </span>
          );
        }

        return (
          <Link
            key={fragment.id}
            to={fragment.href}
            className="inline-flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-ink)_4%,transparent)] hover:text-[var(--editorial-ink)]"
          >
            {content}
          </Link>
        );
      })}
    </nav>
  );
}
