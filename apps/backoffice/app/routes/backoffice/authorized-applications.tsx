import { oauthConsentPageSchema } from "@fragno-dev/backoffice-api/v0/account";
import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { DetailList } from "@fragno-private/design-system/detail-list";
import { InlineAlert } from "@fragno-private/design-system/inline-alert";
import {
  SurfacePanel,
  SurfacePanelBody,
  SurfacePanelFooter,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Form, data, redirect, useNavigation } from "react-router";

import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { callBetterAuth } from "@/fragno/auth/auth-server";
import { requireBackofficeBrowserSession } from "@/fragno/auth/browser-session.server";
import { backofficeOAuthConsentRevokeInputSchema } from "@/fragno/auth/oauth-consent";

import type { Route } from "./+types/authorized-applications";
import { SettingsTabs } from "./settings-tabs";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  await requireBackofficeBrowserSession({ request, context, url });
  const query = new URLSearchParams();
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) {
    query.set("cursor", cursor);
  }
  const response = await callBetterAuth(request, context, `/backoffice/oauth/consents?${query}`);
  if (!response.ok) {
    throw new Response("Unable to load your authorized applications.", { status: response.status });
  }
  return data(oauthConsentPageSchema.parse(await response.json()), {
    headers: { "cache-control": "no-store" },
  });
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
  return [{ title: "Authorized applications · Backoffice" }];
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
                These are your personal OAuth authorizations, including Codemode device approval.
                They are separate from organization app installations and permission grants.
              </p>
              <p className="text-xs text-[var(--bo-muted-2)]">
                Revoking removes the authorization and this client&apos;s refresh and stored access
                tokens, cancels pending device approvals, and blocks new Backoffice execution
                credentials. Previously issued self-contained tokens may remain usable elsewhere
                until they expire; existing Backoffice execution tokens expire within 15 minutes.
              </p>
              {actionData ? <InlineAlert>{actionData.message}</InlineAlert> : null}
            </div>
          </SurfacePanelBody>
          {page.consents.length === 0 ? (
            <BackofficeSystemState
              tone="empty"
              title="You have no authorized applications."
              description="Applications you approve, such as Codemode, appear here."
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
      </div>
    </div>
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
