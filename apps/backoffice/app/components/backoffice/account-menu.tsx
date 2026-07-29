import { Menu } from "@base-ui/react/menu";
import {
  Building2,
  ChevronDown,
  CreditCard,
  Mail,
  Settings,
  Shield,
  UserRound,
  Users,
} from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router";

import type { AuthMeData } from "@/fragno/auth/auth-client";
import { authClient } from "@/fragno/auth/auth-client";

type BackofficeAccountMenuProps = {
  me: AuthMeData | null;
  isLoading?: boolean;
};

function userDisplayName(email: string) {
  const handle = email.split("@")[0] ?? email;
  return handle
    .split(/[._-]+/)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function userInitials(email: string) {
  const handle = email.split("@")[0] ?? email;
  const parts = handle.split(/[._-]+/).filter(Boolean);
  return (parts.length > 0 ? parts : [handle])
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");
}

const menuItemClassName =
  "flex min-h-10 cursor-default items-center gap-3 px-2.5 text-sm text-[var(--bo-muted)] outline-none transition-[scale,background-color,color] duration-150 ease-out data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)] active:scale-[0.96]";

export function BackofficeAccountMenu({ me, isLoading }: BackofficeAccountMenuProps) {
  const { mutate: signOut, loading: signingOut } = authClient.useSignOut();
  const navigate = useNavigate();
  const user = me?.user ?? null;
  const activeOrganization = me?.activeOrganization?.organization ?? null;
  const activeOrganizationPath = activeOrganization
    ? `/backoffice/organisations/${activeOrganization.id}`
    : null;
  const displayName = useMemo(() => (user ? userDisplayName(user.email) : null), [user]);
  const initials = useMemo(() => (user ? userInitials(user.email) : "--"), [user]);

  if (isLoading) {
    return (
      <div
        aria-label="Checking session"
        className="bo-control-surface flex size-10 items-center justify-center bg-[var(--bo-panel)] text-[10px] font-semibold text-[var(--bo-muted-2)]"
      >
        …
      </div>
    );
  }

  if (!user) {
    return (
      <Link
        to="/backoffice/login"
        className="bo-control-surface flex min-h-10 items-center bg-[var(--bo-panel)] px-3 text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-muted)] uppercase transition-[scale,background-color,color,box-shadow] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] active:scale-[0.96]"
      >
        Sign in
      </Link>
    );
  }

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        type="button"
        aria-label={`Open account menu for ${displayName}`}
        className="bo-control-surface group flex min-h-10 shrink-0 items-center gap-2 bg-[var(--bo-panel)] p-1 text-left transition-[scale,background-color,color,box-shadow] duration-150 ease-out outline-none hover:bg-[var(--bo-panel-2)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] data-[popup-open]:bg-[var(--bo-accent-bg)] sm:pr-2"
      >
        <span className="flex size-8 shrink-0 items-center justify-center bg-[var(--bo-panel-2)] text-xs font-semibold text-[var(--bo-fg)] shadow-[inset_0_0_0_1px_var(--bo-border-strong)] group-data-[popup-open]:bg-[var(--bo-panel)]">
          {initials}
        </span>
        <span className="hidden min-w-0 xl:block">
          <span className="block max-w-36 truncate text-xs font-semibold text-[var(--bo-fg)]">
            {displayName}
          </span>
          <span className="block max-w-36 truncate text-[10px] text-[var(--bo-muted-2)]">
            {activeOrganization?.name ?? "No organisation"}
          </span>
        </span>
        <ChevronDown
          className="hidden size-3.5 shrink-0 text-[var(--bo-muted-2)] transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180 sm:block"
          aria-hidden="true"
        />
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Menu.Popup
            data-backoffice-root
            className="bo-popover-surface max-h-[min(36rem,var(--available-height))] w-[min(18rem,calc(100vw-1rem))] origin-top-right overflow-y-auto bg-[var(--bo-panel)] p-2 text-[var(--bo-fg)] transition-[opacity,transform] duration-150 ease-out outline-none data-[ending-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:-translate-y-1 data-[starting-style]:opacity-0"
          >
            <div className="px-2 py-2">
              <p className="truncate text-sm font-semibold text-[var(--bo-fg)]">{displayName}</p>
              <p className="mt-0.5 truncate text-xs text-[var(--bo-muted-2)]">{user.email}</p>
            </div>

            {activeOrganization && activeOrganizationPath ? (
              <>
                <Menu.Separator className="my-1 h-px bg-[var(--bo-border)]" />
                <Menu.Group
                  aria-label={`Current organisation: ${activeOrganization.name}`}
                  className="space-y-1"
                >
                  <p
                    aria-hidden="true"
                    className="truncate px-2 py-1 text-xs font-semibold text-[var(--bo-muted-2)]"
                  >
                    {activeOrganization.name}
                  </p>
                  <Menu.Item
                    render={<Link to={activeOrganizationPath} />}
                    className={menuItemClassName}
                  >
                    <Building2 className="size-4 shrink-0" aria-hidden="true" />
                    Overview
                  </Menu.Item>
                  <Menu.Item
                    render={<Link to={`${activeOrganizationPath}/members`} />}
                    className={menuItemClassName}
                  >
                    <UserRound className="size-4 shrink-0" aria-hidden="true" />
                    Members
                  </Menu.Item>
                  <Menu.Item
                    render={<Link to={`${activeOrganizationPath}/invites`} />}
                    className={menuItemClassName}
                  >
                    <Mail className="size-4 shrink-0" aria-hidden="true" />
                    Invites
                  </Menu.Item>
                  <Menu.Item
                    render={<Link to={`${activeOrganizationPath}/billing`} />}
                    className={menuItemClassName}
                  >
                    <CreditCard className="size-4 shrink-0" aria-hidden="true" />
                    Billing
                  </Menu.Item>
                </Menu.Group>
              </>
            ) : null}

            <Menu.Separator className="my-1 h-px bg-[var(--bo-border)]" />
            <Menu.Group aria-label="Workspace" className="space-y-1">
              <p
                aria-hidden="true"
                className="px-2 py-1 text-[9px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase"
              >
                Workspace
              </p>
              <Menu.Item
                render={<Link to="/backoffice/organisations" />}
                className={menuItemClassName}
              >
                <Users className="size-4 shrink-0" aria-hidden="true" />
                Manage organisations
              </Menu.Item>
              <Menu.Item render={<Link to="/backoffice/settings" />} className={menuItemClassName}>
                <Settings className="size-4 shrink-0" aria-hidden="true" />
                Settings
              </Menu.Item>
            </Menu.Group>

            {user.role === "admin" ? (
              <>
                <Menu.Separator className="my-1 h-px bg-[var(--bo-border)]" />
                <Menu.Group aria-label="Administration" className="space-y-1">
                  <p
                    aria-hidden="true"
                    className="px-2 py-1 text-[9px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase"
                  >
                    Administration
                  </p>
                  <Menu.Item
                    render={<Link to="/backoffice/internals" />}
                    className={menuItemClassName}
                  >
                    <Shield className="size-4 shrink-0" aria-hidden="true" />
                    Internals
                  </Menu.Item>
                </Menu.Group>
              </>
            ) : null}

            <Menu.Separator className="my-1 h-px bg-[var(--bo-border)]" />
            <Menu.Item
              disabled={signingOut}
              onClick={() => {
                void (async () => {
                  try {
                    await signOut({ body: {} });
                  } finally {
                    await navigate("/backoffice/login", { replace: true });
                  }
                })().catch((error: unknown) => {
                  console.error("Backoffice sign-out flow failed", error);
                });
              }}
              className={`${menuItemClassName} disabled:opacity-60`}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
