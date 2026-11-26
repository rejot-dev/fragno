import { oauthConsentPageSchema } from "@fragno-dev/backoffice-api/v0/account";
import { Button, ButtonLink } from "@fragno-private/design-system/controls/button";
import { DetailList } from "@fragno-private/design-system/data/detail-list";
import { InlineAlert } from "@fragno-private/design-system/feedback/inline-alert";
import { BackofficeSystemState } from "@fragno-private/design-system/feedback/system-state";
import {
  SurfacePanel,
  SurfacePanelBody,
  SurfacePanelFooter,
} from "@fragno-private/design-system/layout/surface-panel";
import { Form, data, redirect, useNavigation } from "react-router";

import { backofficePersonalScope } from "@/backoffice-runtime/resolved-scope";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { appMemberReachPath } from "@/fragno/app-installations/contracts";
import { requireBackofficeAppOperationValue } from "@/fragno/apps/errors";
import { callBetterAuth } from "@/fragno/auth/auth-server";
import { requireBackofficeBrowserSession } from "@/fragno/auth/browser-session.server";
import { backofficeOAuthConsentRevokeInputSchema } from "@/fragno/auth/oauth-consent";
import { appConnectionName } from "@/fragno/runtime-tools/families/integrations/app-integration";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/authorized-applications";
import { SettingsTabs } from "./settings-tabs";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const user = await requireBackofficeBrowserSession({ request, context, url });
  const query = new URLSearchParams();
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) {
    query.set("cursor", cursor);
  }
  const [response, memberReach] = await Promise.all([
    callBetterAuth(request, context, `/backoffice/oauth/consents?${query}`),
    loadMemberReachConsents(context, user.id, url.searchParams.get("workspaceCursor")),
  ]);
  if (!response.ok) {
    throw new Response("Unable to load your authorized applications.", { status: response.status });
  }
  return data(
    { ...oauthConsentPageSchema.parse(await response.json()), memberReach },
    { headers: { "cache-control": "no-store" } },
  );
}

/** The apps the person lets into their personal workspace, which they manage on each app's page. */
async function loadMemberReachConsents(
  context: Route.LoaderArgs["context"],
  userId: string,
  cursor: string | null,
) {
  const { runtime } = context.get(BackofficeWorkerContext);
  const me = await runtime.objects.auth
    .singleton()
    .commands.getBackofficeMe({ userId, activeOrganizationId: null });
  const personal = me && backofficePersonalScope(me.user);
  if (!personal) {
    return { consents: [], nextCursor: null };
  }
  const page = requireBackofficeAppOperationValue(
    await runtime.objects.appInstallations
      .for(personal)
      .commands.listMemberReachConsents({ pageSize: 25, cursor }),
  );
  const apps = runtime.objects.apps.singleton().commands;
  const auth = runtime.objects.auth.singleton().commands;
  const consents = await Promise.all(
    page.consents.map(async (consent) => {
      const [app, organization] = await Promise.all([
        apps.getApp({ appId: consent.appId }),
        auth.getOrganization({ organizationId: consent.orgId }),
      ]);
      return {
        key: `${consent.appId} ${consent.orgId}`,
        appName: app ? await appConnectionName(runtime, app) : consent.appId,
        organizationName: organization?.name ?? consent.orgId,
        allowedAt: consent.allowedAt,
        managePath: appMemberReachPath(consent.appId, consent.orgId),
      };
    }),
  );
  return { consents, nextCursor: page.nextCursor };
}

export async function action({ request, context, url }: Route.ActionArgs) {
  await requireBackofficeBrowserSession({ request, context, url });
  const input = backofficeOAuthConsentRevokeInputSchema.safeParse(
    Object.fromEntries(await request.formData()),
  );
  if (!input.success) {
    return data({ message: "Choose an application to revoke." }, { status: 400 });
  }
  const response = await callBetterAuth(request, context, "/backoffice/oauth/revoke-consent", {
    method: "POST",
    body: JSON.stringify(input.data),
  });
  if (!response.ok) {
    return data(
      { message: "Unable to revoke this authorization. Try again." },
      { status: response.status },
    );
  }
  return redirect("/backoffice/settings/authorized-applications");
}

export function headers() {
  return { "cache-control": "no-store", "referrer-policy": "no-referrer" };
}

export function meta() {
  return [{ title: "Authorized applications · Leyway" }];
}

export default function AuthorizedApplications({
  loaderData: page,
  actionData,
}: Pick<Route.ComponentProps, "loaderData" | "actionData">) {
  const navigation = useNavigation();
  const pending = navigation.state !== "idle";
  return (
    <div className="flex flex-1 flex-col">
      <h1 className="sr-only">Authorized applications</h1>
      <SettingsTabs active="applications" />
      <div className={`${backofficePageBodyClassName} flex flex-col gap-4`}>
        <SurfacePanel
          caption={`${page.consents.length} ${page.consents.length === 1 ? "application" : "applications"} you authorized`}
          actions={null}
        >
          <SurfacePanelBody>
            <div className="max-w-3xl space-y-2 text-sm text-pretty text-[var(--bo-muted)]">
              <p>
                These are your personal OAuth authorizations, including devices you signed in, such
                as the Leyway CLI. They are separate from organization app installations and
                permission grants.
              </p>
              <p className="text-xs text-[var(--bo-muted-2)]">
                Revoking removes the authorization and this client&apos;s refresh and stored access
                tokens, cancels pending device approvals, and blocks new Leyway execution
                credentials. Previously issued self-contained tokens may remain usable elsewhere
                until they expire; existing Leyway execution tokens expire within 15 minutes.
              </p>
              {actionData ? <InlineAlert>{actionData.message}</InlineAlert> : null}
            </div>
          </SurfacePanelBody>
          {page.consents.length === 0 ? (
            <BackofficeSystemState
              tone="empty"
              title="You have no authorized applications."
              description="Applications you approve, such as the Leyway CLI, appear here."
              flush
            />
          ) : (
            <ul className="divide-y divide-[color:var(--bo-border)] border-t border-[color:var(--bo-border)]">
              {page.consents.map((consent) => (
                <li
                  key={consent.id}
                  className="flex flex-col gap-3 px-4 py-4 md:flex-row md:items-start md:justify-between"
                >
                  <div className="min-w-0 space-y-2">
                    <div>
                      <h2 className="font-semibold text-[var(--bo-fg)]">{consent.clientName}</h2>
                      <p className="font-mono text-[11px] break-all text-[var(--bo-muted-2)]">
                        {consent.clientId}
                      </p>
                    </div>
                    <DetailList
                      items={[
                        {
                          key: "scopes",
                          label: "OAuth scopes",
                          value: (
                            <span className="font-mono break-all">
                              {consent.scopes.join(", ") || "none"}
                            </span>
                          ),
                        },
                        ...(consent.requestedUserInfoClaims.length > 0
                          ? [
                              {
                                key: "claims",
                                label: "Additional userinfo claims",
                                value: (
                                  <span className="font-mono break-all">
                                    {consent.requestedUserInfoClaims.join(", ")}
                                  </span>
                                ),
                              },
                            ]
                          : []),
                        ...(consent.resources.length > 0
                          ? [
                              {
                                key: "resources",
                                label: "Resources",
                                value: (
                                  <ul className="space-y-0.5 font-mono break-all">
                                    {consent.resources.map((resource) => (
                                      <li key={resource}>{resource}</li>
                                    ))}
                                  </ul>
                                ),
                              },
                            ]
                          : []),
                        {
                          key: "approved",
                          label: "Last approved",
                          value: (
                            <time dateTime={consent.updatedAt}>
                              {formatApprovedAt(consent.updatedAt)}
                            </time>
                          ),
                        },
                      ]}
                    />
                  </div>
                  <Form method="post" className="shrink-0">
                    <input type="hidden" name="clientId" value={consent.clientId} />
                    <Button
                      variant="danger"
                      type="submit"
                      disabled={pending}
                      aria-label={`Revoke access for ${consent.clientName}`}
                    >
                      {pending && navigation.formData?.get("clientId") === consent.clientId
                        ? "Revoking…"
                        : "Revoke access"}
                    </Button>
                  </Form>
                </li>
              ))}
            </ul>
          )}
          {page.nextCursor !== null ? (
            <SurfacePanelFooter>
              <ButtonLink variant="secondary" to={`?cursor=${encodeURIComponent(page.nextCursor)}`}>
                Next page
              </ButtonLink>
            </SurfacePanelFooter>
          ) : null}
        </SurfacePanel>
        <MemberReachConsents memberReach={page.memberReach} />
      </div>
    </div>
  );
}

function MemberReachConsents({
  memberReach,
}: {
  memberReach: Route.ComponentProps["loaderData"]["memberReach"];
}) {
  const { consents, nextCursor } = memberReach;
  return (
    <SurfacePanel
      caption={`${consents.length} ${consents.length === 1 ? "app" : "apps"} with access to your personal workspace`}
      actions={null}
    >
      <SurfacePanelBody>
        <p className="max-w-3xl text-sm text-pretty text-[var(--bo-muted)]">
          When one of these apps acts for you in the organization, it can also act in your personal
          workspace, with what that organization lets it do. Stopping it stops work that is already
          running.
        </p>
      </SurfacePanelBody>
      {consents.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          title="No app has access to your personal workspace."
          description="Apps that need it send you to Leyway to let them in."
          flush
        />
      ) : (
        <ul className="divide-y divide-[color:var(--bo-border)] border-t border-[color:var(--bo-border)]">
          {consents.map((consent) => (
            <li
              key={consent.key}
              className="flex flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0">
                <h2 className="font-semibold text-[var(--bo-fg)]">
                  {consent.appName} for {consent.organizationName}
                </h2>
                <p className="text-sm text-[var(--bo-muted)]">
                  Allowed since{" "}
                  <time dateTime={consent.allowedAt}>{formatApprovedAt(consent.allowedAt)}</time>
                </p>
              </div>
              <ButtonLink variant="secondary" to={consent.managePath}>
                Manage
              </ButtonLink>
            </li>
          ))}
        </ul>
      )}
      {nextCursor !== null ? (
        <SurfacePanelFooter>
          <ButtonLink variant="secondary" to={`?workspaceCursor=${encodeURIComponent(nextCursor)}`}>
            Next page
          </ButtonLink>
        </SurfacePanelFooter>
      ) : null}
    </SurfacePanel>
  );
}

const APPROVED_AT_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  // UTC keeps the server render and the hydrated page identical.
  timeZone: "UTC",
});

function formatApprovedAt(value: string) {
  return `${APPROVED_AT_FORMATTER.format(new Date(value))} UTC`;
}
