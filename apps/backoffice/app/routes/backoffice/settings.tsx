import { useOutletContext } from "react-router";

import { resolveBackofficeUserAuthorityRole } from "@/backoffice-runtime/authority-roles";
import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeBreadcrumbs } from "@/components/backoffice/breadcrumbs";
import { OverflowTabRow } from "@/components/backoffice/overflow-tab-row";
import { requireAuthPrincipal } from "@/fragno/auth/access-token.server";
import { createBackofficeExecutionForPrincipal } from "@/fragno/auth/backoffice-principal.server";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/settings";

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
  organizationIds: readonly string[],
): PermissionScopeDefinition[] => [
  ...(role === "admin" ? [{ key: "system", scope: { kind: "system" as const } }] : []),
  { key: `user:${userId}`, scope: { kind: "user", userId } },
  ...organizationIds.map((orgId) => ({
    key: `org:${orgId}`,
    scope: { kind: "org" as const, orgId },
  })),
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const auth = await requireAuthPrincipal(request, context);
  if (auth.auth.credentialKind !== "jwt" || !auth.auth.expiresAt) {
    throw new Response("Verified access-token authority is required", { status: 401 });
  }

  const organizationIds = auth.auth.sessionContext.organizationIds;
  const authority = {
    userId: auth.user.id,
    role: auth.user.role,
    organizationIds,
  };
  const { runtime } = context.get(BackofficeWorkerContext);

  const scopes = await Promise.all(
    permissionScopeDefinitions(auth.user.id, auth.user.role, organizationIds).map(
      async ({ key, scope }) => {
        const execution = createBackofficeExecutionForPrincipal(auth, scope);
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

function SettingsHeader() {
  return (
    <section className="bo-fragment-surface bo-panel-surface overflow-hidden bg-[var(--bo-panel)]">
      <div className="p-3 md:px-4">
        <h1 className="sr-only">Backoffice settings</h1>
        <div className="flex min-w-0 items-center gap-2">
          <span className="bo-product-code">CFG</span>
          <BackofficeBreadcrumbs
            items={[{ label: "Backoffice", to: "/backoffice" }, { label: "Settings" }]}
          />
        </div>
      </div>
      <div className="border-t border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2">
        <OverflowTabRow
          items={[
            {
              id: "permissions",
              label: "My permissions",
              to: "/backoffice/settings",
              active: true,
            },
          ]}
          ariaLabel="Settings sections"
        />
      </div>
    </section>
  );
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
        detail: `Organisation · ${scope.orgId}`,
      };
    }
    case "project":
      return {
        label: scope.projectId,
        detail: `Project · ${scope.orgId}`,
      };
  }

  throw new Error("Unsupported permission scope.");
}

function PermissionsSettings({
  me,
  authority,
}: {
  me: BackofficeLayoutContext["me"];
  authority: Route.ComponentProps["loaderData"];
}) {
  return (
    <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="grid border-b border-[color:var(--bo-border)] lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="p-4 sm:p-5">
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Authority inspection
          </p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
            Base role grants by scope
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-[var(--bo-muted)]">
            These grants were resolved on the server by the production authority resolver. An
            individual action may still be denied by delegation, resource, object-availability, or
            cross-scope policy.
          </p>
          <p className="mt-2 max-w-2xl text-xs text-[var(--bo-muted-2)]">
            Project scopes currently inherit the same user role grants as their parent organisation,
            with project-specific access enforced when the action executes.
          </p>
        </div>
        <dl className="grid grid-cols-2 border-t border-[color:var(--bo-border)] lg:border-t-0 lg:border-l">
          <div className="min-w-32 p-4">
            <dt className="text-[9px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              Auth role
            </dt>
            <dd className="mt-2 font-mono text-xs text-[var(--bo-fg)]">{authority.authRole}</dd>
          </div>
          <div className="min-w-32 border-l border-[color:var(--bo-border)] p-4">
            <dt className="text-[9px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
              Scopes
            </dt>
            <dd className="mt-2 font-mono text-xs text-[var(--bo-fg)] tabular-nums">
              {authority.scopes.length}
            </dd>
          </div>
        </dl>
      </div>

      <div className="divide-y divide-[color:var(--bo-border)]">
        {authority.scopes.map((entry) => {
          const presentation = scopePresentation(entry.scope, me);
          const permissionsByNamespace = new Map<string, (typeof entry.grants)[number][]>();
          for (const grant of entry.grants) {
            const namespacePermissions = permissionsByNamespace.get(grant.namespace) ?? [];
            namespacePermissions.push(grant);
            permissionsByNamespace.set(grant.namespace, namespacePermissions);
          }

          return (
            <article key={entry.key} className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[16rem_1fr]">
              <div>
                <div className="flex items-center gap-2">
                  <span
                    className={`size-2 ${entry.role ? "bg-emerald-400" : "bg-[var(--bo-muted-2)]"}`}
                    aria-hidden="true"
                  />
                  <h3 className="font-semibold text-[var(--bo-fg)]">{presentation.label}</h3>
                </div>
                <p className="mt-2 text-xs text-[var(--bo-muted)]">{presentation.detail}</p>
                <p className="mt-3 font-mono text-[10px] tracking-[0.12em] text-[var(--bo-accent-fg)] uppercase">
                  {entry.role ?? "no access"}
                </p>
              </div>

              {entry.grants.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {[...permissionsByNamespace.entries()]
                    .sort(([leftNamespace], [rightNamespace]) =>
                      leftNamespace.localeCompare(rightNamespace),
                    )
                    .map(([namespace, permissions]) => (
                      <div
                        key={namespace}
                        className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
                      >
                        <p className="font-mono text-[10px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
                          {namespace}
                        </p>
                        <ul className="mt-2 space-y-1.5">
                          {permissions.map((permission) => (
                            <li
                              key={permission.permission}
                              className="flex items-center gap-2 text-xs text-[var(--bo-fg)]"
                            >
                              <span className="text-emerald-400" aria-hidden="true">
                                ✓
                              </span>
                              <code>{permission.permission}</code>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                </div>
              ) : (
                <div className="flex min-h-20 items-center border border-dashed border-[color:var(--bo-border)] px-4 text-sm text-[var(--bo-muted)]">
                  The authority resolver returned no grants for this scope.
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default function BackofficeSettings({ loaderData }: Route.ComponentProps) {
  const backofficeContext = useOutletContext<BackofficeLayoutContext>();

  return (
    <div className="space-y-4">
      <SettingsHeader />
      <PermissionsSettings me={backofficeContext.me} authority={loaderData} />
    </div>
  );
}
