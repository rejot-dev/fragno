import "@fragno-private/design-system/components.css";

import { AuthorizationScreen } from "@fragno-private/design-system/authorization-screen";
import { Button } from "@fragno-private/design-system/button";
import {
  Form,
  Link,
  data,
  redirect,
  useNavigation,
  isRouteErrorResponse,
  useRouteError,
} from "react-router";
import { z } from "zod";

import { callBetterAuth } from "@/fragno/auth/auth-server";
import { requireBackofficeBrowserSession } from "@/fragno/auth/browser-session.server";
import { backofficeOAuthConsentDetailsSchema } from "@/fragno/auth/oauth-consent";

import type { Route } from "./+types/oauth-consent";

const consentDecisionSchema = z.strictObject({
  intent: z.enum(["approve", "deny"]),
});
const consentRedirectSchema = z.object({
  url: z.string().min(1),
});
const consentErrorSchema = z.object({
  message: z
    .string()
    .default("This authorization request could not be completed. Start the login again."),
});

export async function loader({ request, context, url }: Route.LoaderArgs) {
  await requireBackofficeBrowserSession(request, context);
  const response = await callBetterAuth(request, context, "/backoffice/oauth/consent-details", {
    method: "POST",
    body: JSON.stringify({ oauth_query: url.search.slice(1) }),
  });
  if (!response.ok) {
    throw new Response(
      "This authorization request is invalid, expired, or unavailable. Start the login again from the application.",
      { status: response.status },
    );
  }
  return data(backofficeOAuthConsentDetailsSchema.parse(await response.json()), {
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

export async function action({ request, context, url }: Route.ActionArgs) {
  const input = consentDecisionSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!input.success) {
    return data({ message: "Choose whether to approve or deny this request." }, { status: 400 });
  }
  await requireBackofficeBrowserSession(request, context);
  const response = await callBetterAuth(request, context, "/oauth2/consent", {
    method: "POST",
    body: JSON.stringify({
      accept: input.data.intent === "approve",
      oauth_query: url.search.slice(1),
    }),
  });
  if (!response.ok) {
    return data(consentErrorSchema.parse(await response.json()), { status: response.status });
  }
  const result = consentRedirectSchema.parse(await response.json());
  // Better Auth verifies the signed query and owns callback validation for both decisions.
  return redirect(result.url, {
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

export function headers() {
  return { "cache-control": "no-store", "referrer-policy": "no-referrer" };
}

export function meta() {
  return [{ title: "Authorize application · Backoffice" }];
}

export default function BackofficeOAuthConsent({
  loaderData: consent,
  actionData,
}: Pick<Route.ComponentProps, "loaderData" | "actionData">) {
  const navigation = useNavigation();
  const pending = navigation.state !== "idle";
  return (
    <AuthorizationScreen
      title="Authorize application"
      description={`${consent.clientName} is requesting access to your account.`}
      eyebrow="Backoffice OAuth"
    >
      <div className="space-y-4">
        <p className="text-sm text-[var(--bo-muted)]">
          Signed in as <strong className="text-[var(--bo-fg)]">{consent.userEmail}</strong>
        </p>
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
          <p className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Requested OAuth scopes
          </p>
          <ul className="mt-2 space-y-1 text-sm text-[var(--bo-fg)]">
            {consent.scopes.map((scope) => (
              <li key={scope} className="font-mono">
                {scope}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm leading-6 text-pretty text-[var(--bo-muted)]">
          Approval allows this client to use the scopes and any additional requests listed here. It
          does not install an app or grant organization permissions or Backoffice execution access.
        </p>
        {consent.resources.length > 0 ? (
          <div className="text-xs text-[var(--bo-muted)]">
            <p>Requested resources</p>
            <ul className="mt-1 space-y-1 font-mono break-all">
              {consent.resources.map((resource) => (
                <li key={resource}>{resource}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {consent.claimsRequest !== null ? (
          <div className="text-xs text-[var(--bo-muted)]">
            <p>Additional OIDC claims request</p>
            <pre className="mt-1 break-all whitespace-pre-wrap">{consent.claimsRequest}</pre>
          </div>
        ) : null}
        <dl className="space-y-2 text-xs text-[var(--bo-muted)]">
          <div>
            <dt>Client ID</dt>
            <dd className="mt-1 font-mono break-all">{consent.clientId}</dd>
          </div>
          <div>
            <dt>Return to</dt>
            <dd className="mt-1 break-all">{consent.redirectUri}</dd>
          </div>
        </dl>
        {actionData ? (
          <p role="alert" className="text-sm text-[var(--bo-failed)]">
            {actionData.message}
          </p>
        ) : null}
        <Form method="post" className="flex flex-col gap-2 sm:flex-row">
          <Button variant="accent" type="submit" name="intent" value="approve" disabled={pending}>
            {pending ? "Completing…" : "Approve"}
          </Button>
          <Button variant="secondary" type="submit" name="intent" value="deny" disabled={pending}>
            Deny
          </Button>
        </Form>
        <p className="text-xs leading-5 text-[var(--bo-muted-2)]">
          Review or revoke this authorization in{" "}
          <Link
            to="/backoffice/settings/authorized-applications"
            className="underline underline-offset-4 hover:text-[var(--bo-fg)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--bo-accent)]"
          >
            Settings → Authorized applications
          </Link>
          .
        </p>
      </div>
    </AuthorizationScreen>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <AuthorizationScreen
      title="Authorization unavailable"
      description="Return to the application and start a new login."
      eyebrow="Backoffice OAuth"
    >
      <p role="alert" className="text-sm text-[var(--bo-failed)]">
        {isRouteErrorResponse(error) && typeof error.data === "string"
          ? error.data
          : "This authorization request could not be loaded."}
      </p>
    </AuthorizationScreen>
  );
}
