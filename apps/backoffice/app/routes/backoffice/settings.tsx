import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Icon } from "@fragno-private/design-system/icon";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfaceFacts,
  SurfacePanel,
  SurfacePanelBody,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useOutletContext } from "react-router";

import { resolveBackofficeUserAuthorityRole } from "@/backoffice-runtime/authority-roles";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import {
  createBackofficeExecutionForPrincipal,
  routerContextIdentities,
} from "@/fragno/auth/backoffice-principal.server";
import { requireBackofficePrincipal } from "@/fragno/auth/request-auth.server";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/settings";
import { SettingsTabs } from "./settings-tabs";

export function meta() {
  return [
    { title: "Backoffice Settings" },
    { name: "description", content: "Inspect your effective Backoffice permissions." },
  ];
}

type PermissionScopeDefinition = Readonly<{
  key: string;
  scope: BackofficeContextScope;
}>;

const permissionScopeDefinitions = (
  userId: string,
  role: "user" | "admin",
  organizationId: string | null,
): PermissionScopeDefinition[] => [
  ...(role === "admin" ? [{ key: "system", scope: { kind: "system" as const } }] : []),
  { key: `user:${userId}`, scope: { kind: "user", userId } },
  ...(organizationId
    ? [{ key: `org:${organizationId}`, scope: { kind: "org" as const, orgId: organizationId } }]
    : []),
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const auth = await requireBackofficePrincipal(request, context);
  const organizationId = auth.auth.organization?.id ?? null;
  const authority = {
    userId: auth.user.id,
    role: auth.user.role,
    organizationId,
    // These are the user's own scopes, which no organization administration reaches into.
    administeredMemberId: null,
  };
  const { runtime } = context.get(BackofficeWorkerContext);

  const scopes = await Promise.all(
    permissionScopeDefinitions(auth.user.id, auth.user.role, organizationId).map(
      async ({ key, scope }) => {
        const execution = await createBackofficeExecutionForPrincipal(
          auth,
          scope,
          routerContextIdentities(context),
        );
        const principal = execution.actors.principal;
        if (!principal) {
          throw new Error("User authority inspection requires a principal.");
        }

        const grants = await runtime.authorityResolver.resolvePrincipalPermissions({
          principal,
          execution,
        });

        return {
          key,
          scope,
          role: resolveBackofficeUserAuthorityRole(authority, scope),
          grants,
        };
      },
    ),
  );

  return {
    authRole: auth.user.role,
    scopes,
  };
}

function scopePresentation(
  scope: BackofficeContextScope,
  me: BackofficeLayoutContext["me"],
): { label: string; detail: string } {
  switch (scope.kind) {
    case "system":
      return {
        label: "Global system",
        detail: "Operations that affect the entire Backoffice installation.",
      };
    case "user":
      return {
        label: "Personal workspace",
        detail: me.user.email,
      };
    case "org": {
      const organization = me.organizations.find(
        (entry) => entry.organization.id === scope.orgId,
      )?.organization;
      return {
        label: organization?.name ?? scope.orgId,
        detail: `Organization · ${scope.orgId}`,
      };
    }
    case "app":
      return { label: scope.appId, detail: `App · ${scopePresentation(scope.owner, me).label}` };
    case "project":
      return {
        label: scope.projectId,
        detail: `Project · ${scopePresentation(scope.owner, me).label}`,
      };
    default:
      throw new Error("Unsupported permission scope.", { cause: scope satisfies never });
  }
}

function PermissionsSettings({
  me,
  authority,
}: {
  me: BackofficeLayoutContext["me"];
  authority: Route.ComponentProps["loaderData"];
}) {
  return (
    <>
      <SurfacePanel caption="Authority inspection" actions={null}>
        <SurfaceFacts
          items={[
            { key: "role", label: "Auth role", value: authority.authRole },
            { key: "scopes", label: "Scopes", value: authority.scopes.length },
          ]}
        />
        <SurfacePanelBody>
          <div className="max-w-3xl space-y-2 text-sm text-pretty text-[var(--bo-muted)]">
            <p>
              These base role grants were resolved on the server by the production authority
              resolver. An individual action may still be denied by delegation, resource,
              object-availability, or cross-scope policy.
            </p>
            <p className="text-xs text-[var(--bo-muted-2)]">
              Project scopes currently inherit the same user role grants as their parent
              organization, with project-specific access enforced when the action executes.
            </p>
          </div>
        </SurfacePanelBody>
      </SurfacePanel>

      {authority.scopes.map((entry) => {
        const presentation = scopePresentation(entry.scope, me);
        const permissionsByNamespace = new Map<string, (typeof entry.grants)[number][]>();
        for (const grant of entry.grants) {
          const namespacePermissions = permissionsByNamespace.get(grant.namespace) ?? [];
          namespacePermissions.push(grant);
          permissionsByNamespace.set(grant.namespace, namespacePermissions);
        }

        return (
          <SurfacePanel
            key={entry.key}
            caption={presentation.label}
            actions={
              <BackofficeStatusLight tone={entry.role ? "live" : "muted"}>
                {entry.role ?? "no access"}
              </BackofficeStatusLight>
            }
          >
            <p className="border-t border-[color:var(--bo-border)] px-4 py-3 text-sm text-[var(--bo-muted)]">
              {presentation.detail}
            </p>
            {entry.grants.length > 0 ? (
              <div className="grid gap-x-6 gap-y-4 border-t border-[color:var(--bo-border)] p-4 sm:grid-cols-2 xl:grid-cols-3">
                {[...permissionsByNamespace.entries()]
                  .sort(([leftNamespace], [rightNamespace]) =>
                    leftNamespace.localeCompare(rightNamespace),
                  )
                  .map(([namespace, permissions]) => (
                    <section key={namespace} aria-label={namespace}>
                      <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        {namespace}
                      </p>
                      <ul className="mt-2 space-y-1.5">
                        {permissions.map((permission) => (
                          <li
                            key={permission.permission}
                            className="flex items-center gap-2 text-xs text-[var(--bo-fg)]"
                          >
                            <Icon
                              name="check"
                              className="size-3.5 shrink-0 text-[var(--bo-live)]"
                            />
                            <code>{permission.permission}</code>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
              </div>
            ) : (
              <BackofficeSystemState
                tone="empty"
                label="No grants"
                title="The authority resolver returned no grants for this scope."
                flush
              />
            )}
          </SurfacePanel>
        );
      })}
    </>
  );
}

export default function BackofficeSettings({ loaderData }: Route.ComponentProps) {
  const backofficeContext = useOutletContext<BackofficeLayoutContext>();

  return (
    <div className="flex flex-1 flex-col">
      <h1 className="sr-only">Backoffice settings</h1>
      <SettingsTabs active="permissions" />
      <div className={`${backofficePageBodyClassName} flex flex-col gap-4`}>
        <PermissionsSettings me={backofficeContext.me} authority={loaderData} />
      </div>
    </div>
  );
}
