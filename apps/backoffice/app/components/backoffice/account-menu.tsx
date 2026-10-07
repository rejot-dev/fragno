import {
  AppearanceSubmenu,
  useAppearancePreferences,
} from "@fragno-private/design-system/appearance-menu";
import { ButtonLink } from "@fragno-private/design-system/button";
import {
  SelectorMenu,
  SelectorMenuButton,
  SelectorMenuGroup,
  SelectorMenuLink,
  SelectorMenuNote,
  SelectorMenuPopup,
  SelectorMenuTrigger,
} from "@fragno-private/design-system/selector-menu";
import { usePostHog } from "@posthog/react/slim";
import { useMemo } from "react";

import {
  backofficeRouteScopePath,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";
import { authClient } from "@/fragno/auth/auth-client";
import type { BackofficeMeData } from "@/fragno/auth/contracts";

type BackofficeAccountMenuProps = {
  me: BackofficeMeData | null;
  currentScope: BackofficeRouteScope | null;
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

export function BackofficeAccountMenu({ me, currentScope, isLoading }: BackofficeAccountMenuProps) {
  const posthog = usePostHog();
  const { mutate: signOut, loading: signingOut, error: signOutError } = authClient.useSignOut();
  // Called before the early returns so the stored appearance is applied even while signed out.
  const appearance = useAppearancePreferences();
  const user = me?.user ?? null;
  const activeOrganization = me?.activeOrganization?.organization ?? null;
  const activeOrganizationPath = activeOrganization
    ? `/backoffice/organizations/${encodeURIComponent(activeOrganization.slug)}`
    : null;
  const internalsPath = currentScope
    ? `/backoffice/internals/${backofficeRouteScopePath(currentScope)}`
    : "/backoffice/internals";
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
      <ButtonLink to="/backoffice/login" variant="secondary">
        Sign in
      </ButtonLink>
    );
  }

  return (
    <SelectorMenu>
      <SelectorMenuTrigger
        label="Account"
        value={displayName}
        ariaLabel={`Open account menu for ${displayName}`}
        layout={{ kind: "hug", initials }}
      />

      <SelectorMenuPopup align="end" height="content" className="w-[min(18rem,calc(100vw-1rem))]">
        <div className="px-2.5 py-2">
          <p className="truncate text-sm font-semibold text-[var(--bo-fg)]">{displayName}</p>
          <p className="mt-0.5 truncate text-xs text-[var(--bo-muted-2)]">{user.email}</p>
        </div>

        {activeOrganization && activeOrganizationPath ? (
          <SelectorMenuGroup label={activeOrganization.name}>
            <SelectorMenuLink to={activeOrganizationPath} icon="briefcase">
              Overview
            </SelectorMenuLink>
            <SelectorMenuLink to={`${activeOrganizationPath}/members`} icon="user">
              Members
            </SelectorMenuLink>
            <SelectorMenuLink to={`${activeOrganizationPath}/invites`} icon="mail">
              Invites
            </SelectorMenuLink>
            <SelectorMenuLink to={`${activeOrganizationPath}/billing`} icon="credit-card">
              Billing
            </SelectorMenuLink>
          </SelectorMenuGroup>
        ) : null}

        <SelectorMenuGroup label="Workspace">
          <SelectorMenuLink to="/backoffice/organizations" icon="users">
            Manage organizations
          </SelectorMenuLink>
          <SelectorMenuLink to="/backoffice/settings" icon="settings">
            Settings
          </SelectorMenuLink>
          <SelectorMenuLink to="/backoffice/settings/authorized-applications" icon="shield">
            Authorized applications
          </SelectorMenuLink>
        </SelectorMenuGroup>

        {user.role === "admin" ? (
          <SelectorMenuGroup label="Administration">
            <SelectorMenuLink to={internalsPath} icon="shield">
              Internals
            </SelectorMenuLink>
          </SelectorMenuGroup>
        ) : null}

        <SelectorMenuGroup label={null}>
          <AppearanceSubmenu preferences={appearance} />
          <SelectorMenuButton
            icon="log-out"
            disabled={signingOut}
            onClick={() => {
              void signOut({ body: {} })
                .then(() => {
                  if (posthog) {
                    posthog.reset();
                  }
                  window.location.replace("/backoffice/login");
                })
                .catch(() => undefined);
            }}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </SelectorMenuButton>
          {signOutError ? (
            <SelectorMenuNote tone="error">
              {signOutError instanceof Error ? signOutError.message : "Unable to sign out."}
            </SelectorMenuNote>
          ) : null}
        </SelectorMenuGroup>
      </SelectorMenuPopup>
    </SelectorMenu>
  );
}
