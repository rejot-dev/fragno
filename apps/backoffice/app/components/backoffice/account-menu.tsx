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
import { Link } from "react-router";

import { authClient } from "@/fragno/auth/auth-client";
import type { BackofficeMeData } from "@/fragno/auth/contracts";

type BackofficeAccountMenuProps = {
  me: BackofficeMeData | null;
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
  const { mutate: signOut, loading: signingOut, error: signOutError } = authClient.useSignOut();
  const user = me?.user ?? null;
  const activeOrganization = me?.activeOrganization?.organization ?? null;
  const activeOrganizationPath = activeOrganization
    ? `/backoffice/organizations/${encodeURIComponent(activeOrganization.slug)}`
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
        className="group flex min-h-12 shrink-0 cursor-pointer items-center gap-2.5 self-stretch py-3.5 pr-5.5 pl-6 text-left transition-[scale,color] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96]"
      >
        <span className="flex size-8 shrink-0 items-center justify-center bg-[var(--bo-panel-2)] text-xs font-semibold text-[var(--bo-fg)] xl:hidden">
          {initials}
        </span>
        <span className="hidden min-w-0 flex-col gap-0.5 xl:flex">
          <span className="text-[9px] font-semibold text-[var(--bo-muted-2)]">Account</span>
          <span className="max-w-36 min-w-0 truncate text-sm font-extrabold tracking-normal text-[var(--bo-fg)] normal-case">
            {displayName}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className="hidden size-3.5 shrink-0 text-[var(--bo-muted-2)] transition-[transform,color] duration-150 ease-out group-data-[popup-open]:rotate-180 group-data-[popup-open]:text-[var(--bo-accent-fg)] sm:block"
        />
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={0} className="z-50">
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
                  aria-label={`Current organization: ${activeOrganization.name}`}
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
                render={<Link to="/backoffice/organizations" />}
                className={menuItemClassName}
              >
                <Users className="size-4 shrink-0" aria-hidden="true" />
                Manage organizations
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
              closeOnClick={false}
              disabled={signingOut}
              onClick={() => {
                void signOut({ body: {} })
                  .then(() => {
                    window.location.replace("/backoffice/login");
                  })
                  .catch(() => undefined);
              }}
              className={`${menuItemClassName} disabled:opacity-60`}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </Menu.Item>
            {signOutError ? (
              <p role="alert" className="px-2.5 py-2 text-xs text-red-400">
                {signOutError instanceof Error ? signOutError.message : "Unable to sign out."}
              </p>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
