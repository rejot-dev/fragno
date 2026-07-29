import type { ReactNode } from "react";

import type { AuthMeData } from "@/fragno/auth/auth-client";

import { BackofficeClsDebugger } from "./cls-debugger";
import { BackofficeTopBar } from "./top-bar";

type BackofficeShellProps = {
  children: ReactNode;
  me: AuthMeData | null;
  isLoading?: boolean;
};

export function BackofficeShell({ children, me, isLoading }: BackofficeShellProps) {
  return (
    <div
      data-backoffice-root
      className="relative isolate min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <BackofficeClsDebugger />
      <div className="bo-grid-backdrop pointer-events-none absolute inset-0" />
      <div className="relative min-h-screen">
        <BackofficeTopBar me={me} isLoading={isLoading} />
        <main className="min-w-0 px-2 py-2 sm:px-3 sm:py-3 lg:px-4 lg:py-4">
          <div className="min-w-0">{children}</div>
        </main>
      </div>
    </div>
  );
}
