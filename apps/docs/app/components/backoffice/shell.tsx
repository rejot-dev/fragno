import type { ReactNode } from "react";
import type { AuthMeData } from "@/fragno/auth-client";
import { BackofficeClsDebugger } from "./cls-debugger";
import { BackofficeSidebar } from "./sidebar";

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
      <div className="relative flex min-h-screen flex-col lg:flex-row">
        <BackofficeSidebar me={me} isLoading={isLoading} />
        <main className="flex min-w-0 flex-1 px-4 py-4">
          <div className="min-w-0 flex-1 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 shadow-[0_8px_24px_rgba(15,23,42,0.12)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.4)]">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
