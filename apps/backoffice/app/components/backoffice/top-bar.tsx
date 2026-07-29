import { Link, NavLink, useLocation } from "react-router";

import type { AuthMeData } from "@/fragno/auth/auth-client";
import { authClient } from "@/fragno/auth/auth-client";
import { cn } from "@/lib/utils";

import { BackofficeAccountMenu } from "./account-menu";
import { BackofficeFragmentMark } from "./fragment-mark";
import { BackofficeThemeMenu } from "./theme-menu";

type BackofficeTopBarProps = {
  me: AuthMeData | null;
  isLoading?: boolean;
};

type PrimaryNavigationItem = {
  index: string;
  label: string;
  to: string;
  isActive: (pathname: string) => boolean;
};

const PRIMARY_NAVIGATION: PrimaryNavigationItem[] = [
  {
    index: "01",
    label: "Automations",
    to: "/backoffice/automations",
    isActive: (pathname) => pathname.startsWith("/backoffice/automations"),
  },
  {
    index: "02",
    label: "Sessions",
    to: "/backoffice/sessions",
    isActive: (pathname) => pathname.startsWith("/backoffice/sessions"),
  },
  {
    index: "03",
    label: "Files",
    to: "/backoffice/files",
    isActive: (pathname) => pathname.startsWith("/backoffice/files"),
  },
];

function PrimaryNavigation({ mobile = false }: { mobile?: boolean }) {
  const location = useLocation();

  return (
    <nav aria-label="Backoffice" className={mobile ? "grid grid-cols-3" : "flex h-full min-w-0"}>
      {PRIMARY_NAVIGATION.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) => {
            const active = isActive || item.isActive(location.pathname);
            return cn(
              "relative flex min-w-0 items-center justify-center border-b-2 font-semibold uppercase transition-[scale,background-color,border-color,color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]",
              mobile
                ? "min-h-11 px-1 text-[9px] tracking-[0.1em]"
                : "min-h-14 px-4 text-[10px] tracking-[0.18em]",
              active
                ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
                : "border-transparent text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]",
            );
          }}
        >
          <span className="hidden font-mono text-[8px] tracking-normal text-[var(--bo-muted-2)] lg:mr-2 lg:inline">
            {item.index}
          </span>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function BackofficeTopBar({ me, isLoading }: BackofficeTopBarProps) {
  const { data: meData, loading: meLoading } = authClient.useMe();
  const effectiveMe = meData === undefined ? me : meData;
  const sessionLoading = isLoading || (!effectiveMe && meLoading);

  return (
    <header className="sticky top-0 z-30 border-b border-[color:var(--bo-border)] bg-[color:var(--bo-panel)]/95 shadow-[0_1px_3px_rgba(15,23,42,0.06)] backdrop-blur-md dark:shadow-[0_1px_3px_rgba(0,0,0,0.35)]">
      <div className="flex min-h-14 items-center gap-2 px-2 sm:gap-3 sm:px-3 lg:px-4">
        <Link
          to="/backoffice"
          className="flex min-h-10 shrink-0 items-center gap-2 px-1 text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-fg)] uppercase transition-[scale,color] duration-150 ease-out outline-none hover:text-[var(--bo-accent-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] sm:px-2"
        >
          <BackofficeFragmentMark palette="blue" />
          Backoffice
        </Link>

        <div className="hidden min-w-0 flex-1 self-stretch sm:block">
          <PrimaryNavigation />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <BackofficeThemeMenu />
          <BackofficeAccountMenu me={effectiveMe} isLoading={sessionLoading} />
        </div>
      </div>

      <div className="border-t border-[color:var(--bo-border)] sm:hidden">
        <PrimaryNavigation mobile />
      </div>
    </header>
  );
}
