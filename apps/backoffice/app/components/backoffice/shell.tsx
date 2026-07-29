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
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,rgba(var(--bo-overlay),0.96),rgba(var(--bo-overlay),0.96)),linear-gradient(90deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px),linear-gradient(0deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px)] bg-[size:100%_100%,28px_28px,28px_28px]" />
      <div className="relative min-h-screen">
        <BackofficeTopBar me={me} isLoading={isLoading} />
        <main className="min-w-0 px-2 py-2 sm:px-3 sm:py-3 lg:px-4 lg:py-4">
          <div className="min-w-0">{children}</div>
        </main>
      </div>
    </div>
  );
}
