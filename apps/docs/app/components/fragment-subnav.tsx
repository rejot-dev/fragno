import { Link } from "react-router";
import { cn } from "@/lib/cn";

const fragments = [
  { id: "stripe", label: "Stripe", href: "/fragments/stripe", dot: "bg-violet-500/80" },
  { id: "forms", label: "Forms", href: "/fragments/forms", dot: "bg-sky-500/80" },
  { id: "workflows", label: "Workflows", href: "/fragments/workflows", dot: "bg-amber-500/80" },
  { id: "upload", label: "Uploads", href: "/fragments/upload", dot: "bg-cyan-500/80" },
  { id: "auth", label: "Auth", href: "/fragments/auth", dot: "bg-emerald-500/80" },
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
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500",
        className,
      )}
    >
      <span className="rounded-full border border-slate-200/70 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-white/10 dark:text-slate-300">
        First party fragment
      </span>
      <span
        aria-hidden
        className="mx-1 inline-flex h-4 w-px rounded-full bg-slate-200 dark:bg-slate-700"
      />
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
              className="inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/70 px-3 py-1 text-[10px] font-semibold text-slate-900 dark:border-white/10 dark:bg-slate-950/60 dark:text-white"
            >
              {content}
            </span>
          );
        }

        return (
          <Link
            key={fragment.id}
            to={fragment.href}
            className="inline-flex items-center gap-2 rounded-full border border-slate-200/70 px-3 py-1 text-[10px] font-semibold text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-900 dark:border-white/10 dark:text-slate-300 dark:hover:text-white"
          >
            {content}
          </Link>
        );
      })}
    </div>
  );
}
