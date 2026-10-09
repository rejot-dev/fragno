import { oauthConsentPageSchema } from "@fragno-dev/backoffice-api/v0/account";
import { BackofficeBreadcrumbs } from "@fragno-private/design-system/breadcrumbs";
import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { OverflowTabRow } from "@fragno-private/design-system/overflow-tab-row";
import { Form, data, redirect, useNavigation } from "react-router";

import { callBetterAuth } from "@/fragno/auth/auth-server";
import { requireBackofficeBrowserSession } from "@/fragno/auth/browser-session.server";
import { backofficeOAuthConsentRevokeInputSchema } from "@/fragno/auth/oauth-consent";

import type { Route } from "./+types/authorized-applications";

export async function loader({ request, context, url }: Route.LoaderArgs) {
  await requireBackofficeBrowserSession(request, context);
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

export async function action({ request, context }: Route.ActionArgs) {
  await requireBackofficeBrowserSession(request, context);
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
    <div className="space-y-4">
      <section className="bo-fragment-surface bo-panel-surface overflow-hidden bg-[var(--bo-header-bg)]">
        <div className="p-3 md:px-4">
          <h1 className="sr-only">Authorized applications</h1>
          <BackofficeBreadcrumbs
            items={[{ label: "Backoffice", to: "/backoffice" }, { label: "Settings" }]}
          />
        </div>
        <div className="border-t border-[color:var(--bo-border)] p-2">
          <OverflowTabRow
            items={[
              {
                id: "permissions",
                label: "My permissions",
                to: "/backoffice/settings",
                active: false,
              },
              {
                id: "applications",
                label: "Authorized applications",
                to: "/backoffice/settings/authorized-applications",
                active: true,
              },
            ]}
            ariaLabel="Settings sections"
          />
        </div>
      </section>
      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
        <div className="border-b border-[color:var(--bo-border)] p-4 sm:p-5">
          <h2 className="text-xl font-semibold text-[var(--bo-fg)]">Applications you authorized</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-pretty text-[var(--bo-muted)]">
            These are your personal OAuth authorizations, including Codemode device approval. They
            are separate from organization app installations and permission grants.
          </p>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-[var(--bo-muted-2)]">
            Revoking removes the authorization and this client's refresh and stored access tokens,
            cancels pending device approvals, and blocks new Backoffice execution credentials.
            Previously issued self-contained tokens may remain usable elsewhere until they expire;
            existing Backoffice execution tokens expire within 15 minutes.
          </p>
          {actionData ? (
            <p role="alert" className="mt-3 text-sm text-[var(--bo-failed)]">
              {actionData.message}
            </p>
          ) : null}
        </div>
        {page.consents.length === 0 ? (
          <p className="p-5 text-sm text-[var(--bo-muted)]">You have no authorized applications.</p>
        ) : (
          <div className="divide-y divide-[color:var(--bo-border)]">
            {page.consents.map((consent) => (
              <article key={consent.id} className="grid gap-4 p-4 sm:p-5 md:grid-cols-[1fr_auto]">
                <div className="min-w-0">
                  <h3 className="font-semibold text-[var(--bo-fg)]">{consent.clientName}</h3>
                  <p className="mt-1 font-mono text-xs break-all text-[var(--bo-muted-2)]">
                    {consent.clientId}
                  </p>
                  <p className="mt-3 text-sm text-[var(--bo-muted)]">
                    OAuth scopes:{" "}
                    <span className="font-mono">{consent.scopes.join(", ") || "none"}</span>
                  </p>
                  {consent.requestedUserInfoClaims.length > 0 ? (
                    <p className="mt-2 text-sm text-[var(--bo-muted)]">
                      Additional userinfo claims:{" "}
                      <span className="font-mono">
                        {consent.requestedUserInfoClaims.join(", ")}
                      </span>
                    </p>
                  ) : null}
                  {consent.resources.length > 0 ? (
                    <div className="mt-2 text-xs text-[var(--bo-muted)]">
                      <p>Resources</p>
                      <ul className="mt-1 space-y-1 font-mono break-all">
                        {consent.resources.map((resource) => (
                          <li key={resource}>{resource}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
                    Last approved: <time dateTime={consent.updatedAt}>{consent.updatedAt}</time>
                  </p>
                </div>
                <Form method="post" className="self-start">
                  <input type="hidden" name="clientId" value={consent.clientId} />
                  <Button
                    variant="secondary"
                    type="submit"
                    disabled={pending}
                    aria-label={`Revoke access for ${consent.clientName}`}
                  >
                    {pending && navigation.formData?.get("clientId") === consent.clientId
                      ? "Revoking…"
                      : "Revoke access"}
                  </Button>
                </Form>
              </article>
            ))}
          </div>
        )}
      </section>
      {page.nextCursor !== null ? (
        <ButtonLink variant="secondary" to={`?cursor=${encodeURIComponent(page.nextCursor)}`}>
          Next page
        </ButtonLink>
      ) : null}
    </div>
  );
}
