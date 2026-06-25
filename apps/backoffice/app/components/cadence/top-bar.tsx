import { Building2 } from "lucide-react";

import type { AuthMeData } from "@/fragno/auth/auth-client";
import { authClient } from "@/fragno/auth/auth-client";

import { CADENCE_NAV_ITEMS, CADENCE_SETTINGS_ITEM, CadenceNavLink } from "./cadence-sidebar";
import { CadenceWordmark } from "./wordmark";

/** The active organisation, shown in the top bar. */
function CadenceOrg({ me }: { me: AuthMeData | null }) {
  const { data: meData } = authClient.useMe();
  const org = (meData ?? me)?.activeOrganization?.organization ?? null;
  if (!org) {
    return null;
  }
  return (
    <span className="flex items-center gap-2 rounded-lg border border-[color:var(--cad-line)] bg-[var(--cad-panel)] px-2.5 py-1">
      <Building2 aria-hidden className="h-3 w-3 shrink-0 text-[var(--cad-muted-2)]" />
      <span className="max-w-[12rem] truncate text-xs font-medium text-[var(--cad-fg)]">
        {org.name}
      </span>
    </span>
  );
}

/**
 * The top bar. It carries the active organisation and session status, plus the
 * wordmark and section navigation on small screens (where the sidebar is hidden).
 */
export function TopBar({ me }: { me: AuthMeData | null }) {
  return (
    <div className="sticky top-0 z-30 border-b border-[color:var(--cad-line)] bg-[rgb(from_var(--cad-bg)_r_g_b/0.85)] backdrop-blur-md">
      <div className="flex h-14 items-center justify-between gap-4 px-4 md:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <div className="lg:hidden">
            <CadenceWordmark />
          </div>
          {/* On desktop the sidebar's team switcher carries the org; show it here only on small screens. */}
          <div className="lg:hidden">
            <CadenceOrg me={me} />
          </div>
        </div>
      </div>

      {/* Mobile section nav */}
      <nav
        aria-label="Cadence"
        className="cad-scroll flex gap-2 overflow-x-auto border-t border-[color:var(--cad-line)] px-4 py-2 lg:hidden"
      >
        {[...CADENCE_NAV_ITEMS, CADENCE_SETTINGS_ITEM].map((item) => (
          <div key={item.to} className="min-w-[8.5rem] shrink-0">
            <CadenceNavLink item={item} />
          </div>
        ))}
      </nav>
    </div>
  );
}
