import { Menu } from "@base-ui/react/menu";
import {
  AudioLines,
  ChevronsUpDown,
  type LucideIcon,
  Radio,
  Search,
  SlidersHorizontal,
  Workflow,
} from "lucide-react";
import { useMemo } from "react";
import { Link, NavLink, useNavigate } from "react-router";

import type { AuthMeData } from "@/fragno/auth/auth-client";
import { authClient } from "@/fragno/auth/auth-client";
import { cn } from "@/lib/utils";

export type CadenceNavItem = {
  label: string;
  /** A short description shown beneath the label. */
  detail: string;
  to: string;
  icon: LucideIcon;
  end?: boolean;
};

/** The main sections of the app. */
export const CADENCE_NAV_ITEMS: CadenceNavItem[] = [
  {
    label: "Exec",
    detail: "Compose & launch",
    to: "/",
    icon: AudioLines,
    end: true,
  },
  { label: "Workflows", detail: "Inspect a workflow", to: "/workflows", icon: Workflow },
  { label: "Ops", detail: "Monitor runs", to: "/ops", icon: Radio },
];

/** Pinned to the bottom of the sidebar, above the user menu. */
export const CADENCE_SETTINGS_ITEM: CadenceNavItem = {
  label: "Settings",
  detail: "Workspace admin",
  to: "/settings",
  icon: SlidersHorizontal,
};

export function CadenceSidebar({ me }: { me: AuthMeData | null }) {
  return (
    <aside className="hidden w-[264px] shrink-0 flex-col border-r border-[color:var(--cad-line)] bg-[var(--cad-bg-2)] lg:sticky lg:top-0 lg:flex lg:h-screen">
      <div className="box-content flex h-14 shrink-0 items-center border-b border-[color:var(--cad-line)] px-3">
        <CadenceTeamSwitcher me={me} />
      </div>
      <div className="p-3">
        <CadenceSearch />
      </div>

      <nav
        aria-label="Cadence"
        className="cad-scroll flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3"
      >
        {CADENCE_NAV_ITEMS.map((item) => (
          <CadenceSideNavLink key={item.to} item={item} />
        ))}
      </nav>

      <div className="flex flex-col gap-1 border-t border-[color:var(--cad-line)] p-3">
        <CadenceSideNavLink item={CADENCE_SETTINGS_ITEM} />
        <CadenceUserCard me={me} />
      </div>
    </aside>
  );
}

/**
 * The workspace/team switcher at the top of the sidebar: a brand tile beside the
 * active organisation name. Opens workspace admin.
 */
function CadenceTeamSwitcher({ me }: { me: AuthMeData | null }) {
  const { data: meData } = authClient.useMe();
  const navigate = useNavigate();
  const org = (meData ?? me)?.activeOrganization?.organization ?? null;

  return (
    <button
      type="button"
      onClick={() => void navigate("/settings")}
      aria-label="Switch workspace"
      className="group flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-[var(--cad-panel)]/60"
    >
      <span
        aria-hidden
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-[var(--cad-brass)] to-[var(--cad-brass-strong)] text-white shadow-[var(--cad-shadow)]"
      >
        <AudioLines className="h-4 w-4" strokeWidth={2.5} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[9px] leading-tight font-medium text-[var(--cad-muted-2)]">
          Team
        </span>
        <span className="block truncate text-xs leading-tight font-bold text-[var(--cad-fg)]">
          {org?.name ?? "Workspace"}
        </span>
      </span>
      <ChevronsUpDown
        aria-hidden
        className="h-4 w-4 shrink-0 text-[var(--cad-muted-2)] transition-colors group-hover:text-[var(--cad-muted)]"
      />
    </button>
  );
}

/**
 * A search affordance styled as an inset field. Presentational for now — it
 * mirrors the section's keyboard shortcut so it can host a command palette later.
 */
function CadenceSearch() {
  return (
    <button
      type="button"
      className="group flex w-full items-center gap-2.5 rounded-md border border-[color:var(--cad-line)] bg-[var(--cad-panel-2)] px-3 py-1.5 text-left text-xs text-[var(--cad-muted-2)] transition-colors hover:bg-[var(--cad-panel-hover)] hover:text-[var(--cad-muted)]"
    >
      <Search aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
      <span className="flex-1">Search</span>
      <kbd className="cad-mono rounded-sm border border-[color:var(--cad-line)] bg-[var(--cad-panel)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--cad-muted-2)]">
        ⌘F
      </kbd>
    </button>
  );
}

/**
 * An expanded navigation row for the desktop sidebar. The active route floats as
 * a white card; the rest sit flat with a muted icon and label.
 */
export function CadenceSideNavLink({ item }: { item: CadenceNavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }: { isActive: boolean }) =>
        cn(
          "group flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors",
          isActive
            ? "border-[color:var(--cad-line)] bg-[var(--cad-panel)] shadow-[0_1px_2px_oklch(0.3_0.02_60/0.06)]"
            : "border-transparent hover:bg-[var(--cad-panel)]/60",
        )
      }
    >
      {({ isActive }: { isActive: boolean }) => (
        <>
          <Icon
            className={cn(
              "h-5 w-5 shrink-0 transition-colors",
              isActive
                ? "text-[var(--cad-fg)]"
                : "text-[var(--cad-muted-2)] group-hover:text-[var(--cad-fg)]",
            )}
            strokeWidth={2}
          />
          <span
            className={cn(
              "text-xs transition-colors",
              isActive
                ? "font-semibold text-[var(--cad-fg)]"
                : "font-medium text-[var(--cad-muted)] group-hover:text-[var(--cad-fg)]",
            )}
          >
            {item.label}
          </span>
        </>
      )}
    </NavLink>
  );
}

export function CadenceNavLink({ item }: { item: CadenceNavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }: { isActive: boolean }) =>
        cn(
          "group flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors",
          isActive ? "bg-[var(--cad-brass-bg)]" : "hover:bg-[var(--cad-panel)]",
        )
      }
    >
      {({ isActive }: { isActive: boolean }) => (
        <>
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-sm transition-colors",
              isActive
                ? "bg-[var(--cad-brass)] text-white"
                : "bg-[var(--cad-panel-2)] text-[var(--cad-muted-2)] group-hover:text-[var(--cad-fg)]",
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span
              className={cn(
                "block text-sm font-medium",
                isActive ? "text-[var(--cad-fg)]" : "text-[var(--cad-muted)]",
              )}
            >
              {item.label}
            </span>
            <span className="cad-mono block truncate text-[10px] tracking-wide text-[var(--cad-muted-2)]">
              {item.detail}
            </span>
          </span>
        </>
      )}
    </NavLink>
  );
}

export function CadenceUserCard({ me }: { me: AuthMeData | null }) {
  const { data: meData } = authClient.useMe();
  const { mutate: signOut, loading: signingOut } = authClient.useSignOut();
  const navigate = useNavigate();
  const user = (meData ?? me)?.user ?? null;

  const { displayName, initials } = useMemo(() => {
    if (!user) {
      return { displayName: null, initials: "—" };
    }
    const handle = user.email.split("@")[0] ?? user.email;
    const parts = handle.split(/[._-]+/).filter(Boolean);
    const name = (parts.length ? parts : [handle])
      .map((p) => p.slice(0, 1).toUpperCase() + p.slice(1))
      .join(" ");
    const init = (parts.length ? parts : [handle])
      .slice(0, 2)
      .map((p) => p.slice(0, 1).toUpperCase())
      .join("");
    return { displayName: name, initials: init };
  }, [user]);

  if (!user) {
    return (
      <Link
        to="/backoffice/login"
        aria-label="Sign in"
        className="flex items-center gap-3 rounded-md border border-transparent px-2 py-2 text-sm font-medium text-[var(--cad-muted)] transition-colors hover:border-[color:var(--cad-line)] hover:bg-[var(--cad-panel)] hover:text-[var(--cad-fg)]"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[color:var(--cad-line)] bg-[var(--cad-panel)] text-xs font-bold text-[var(--cad-muted-2)]">
          —
        </span>
        Sign in
      </Link>
    );
  }

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label={displayName ?? user.email}
        className="group flex w-full items-center gap-3 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:border-[color:var(--cad-line)] hover:bg-[var(--cad-panel)]"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--cad-brass)] text-xs font-bold text-white">
          {initials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-[var(--cad-fg)]">
            {displayName}
          </span>
          <span className="block truncate text-[10px] text-[var(--cad-muted-2)]">{user.email}</span>
        </span>
        <ChevronsUpDown
          aria-hidden
          className="h-4 w-4 shrink-0 text-[var(--cad-muted-2)] transition-colors group-hover:text-[var(--cad-muted)]"
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={10} className="z-50">
          <Menu.Popup
            data-cadence-root
            className="w-60 rounded-md border border-[color:var(--cad-line)] bg-[var(--cad-panel)] p-2 text-[var(--cad-fg)] shadow-[var(--cad-shadow)]"
          >
            <div className="border-b border-[color:var(--cad-line)] px-3 pt-1.5 pb-2.5">
              <p className="truncate text-sm font-medium text-[var(--cad-fg)]">{displayName}</p>
              <p className="truncate text-xs text-[var(--cad-muted-2)]">{user.email}</p>
            </div>
            <Menu.Item
              onClick={() => void navigate("/settings")}
              className="mt-1.5 cursor-pointer rounded-sm px-3 py-2 text-sm text-[var(--cad-muted)] transition-colors data-[highlighted]:bg-[var(--cad-panel-2)] data-[highlighted]:text-[var(--cad-fg)]"
            >
              Settings
            </Menu.Item>
            <Menu.Separator className="my-1.5 h-px bg-[var(--cad-line)]" />
            <Menu.Item
              disabled={signingOut}
              onClick={() => {
                void (async () => {
                  try {
                    await signOut({ body: {} });
                  } finally {
                    await navigate("/backoffice/login", { replace: true });
                  }
                })();
              }}
              className="cursor-pointer rounded-sm px-3 py-2 text-sm text-[var(--cad-rose)] transition-colors disabled:opacity-60 data-[highlighted]:bg-[var(--cad-rose-bg)]"
            >
              Sign out
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
