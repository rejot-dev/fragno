import type { ReactNode } from "react";
import { useMatches } from "react-router";

import type { AuthMeData } from "@/fragno/auth/auth-client";
import { cn } from "@/lib/utils";

import { CadenceSidebar } from "./cadence-sidebar";
import { TopBar } from "./top-bar";

/**
 * App frame. Wraps every Cadence page: a warm background, the left nav sidebar
 * (desktop), and the top bar (mobile nav + status).
 *
 * Routes that export `handle = { fullBleed: true }` opt out of the centered,
 * padded content column and fill the entire main area instead.
 */
export function CadenceShell({ children, me }: { children: ReactNode; me: AuthMeData | null }) {
  const matches = useMatches();
  const fullBleed = matches.some(
    (match) => (match.handle as { fullBleed?: boolean } | undefined)?.fullBleed,
  );
  return (
    <div
      data-cadence-root
      className="cad-stage relative isolate flex h-screen overflow-hidden text-[var(--cad-fg)]"
    >
      <CadenceSidebar me={me} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar me={me} />
        <main
          className={cn(
            "cad-scroll min-h-0 min-w-0 flex-1 overflow-y-auto",
            fullBleed ? "" : "px-4 py-8 md:px-8 lg:px-12 lg:py-12",
          )}
        >
          <div
            className={cn(
              "flex w-full flex-col",
              fullBleed ? "h-full min-h-0" : "mx-auto min-h-full max-w-6xl space-y-10",
            )}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
