import "@fragno-private/design-system/components.css";

import { Button } from "@fragno-private/design-system/controls/button";
import { AuthorizationScreen } from "@fragno-private/design-system/layout/authorization-screen";
import {
  Form,
  data,
  isRouteErrorResponse,
  redirect,
  useNavigation,
  useRouteError,
} from "react-router";

import { requireOwnBrowserSession } from "@/fragno/auth/browser-session.server";

import type { Route } from "./+types/app-member-reach";
import { requireOnboardedAppUser } from "./app-install.server";
import { decideAppMemberReach, loadAppMemberReach } from "./app-member-reach.server";

const noStoreHeaders = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

function rethrowRequestError(error: unknown): never {
  if (error instanceof Error && error.name === "AppMemberReachRequestError") {
    throw new Response(error.message, { status: 404 });
  }
  throw error;
}

export async function loader({ request, context, url, params }: Route.LoaderArgs) {
  const user = await requireOwnBrowserSession({ request, context, url });
  const me = await requireOnboardedAppUser(context, url, user.id);
  const page = await loadAppMemberReach(context, {
    me,
    appId: params.appId,
    orgId: params.orgId,
  }).catch(rethrowRequestError);
  return data({ userEmail: user.email, ...page }, { headers: noStoreHeaders });
}

export async function action({ request, context, url, params }: Route.ActionArgs) {
  // The session cookie rides along on a request another site sends, so only this page decides.
  if (request.method !== "POST") {
    throw new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new Response("Letting an app in requires a same-origin POST.", { status: 403 });
  }
  const user = await requireOwnBrowserSession({ request, context, url });
  const me = await requireOnboardedAppUser(context, url, user.id);
  const result = await decideAppMemberReach(context, {
    me,
    appId: params.appId,
    orgId: params.orgId,
    formData: await request.formData(),
  }).catch(rethrowRequestError);
  if (result.status === "invalid") {
    return data({ message: result.message }, { status: 400, headers: noStoreHeaders });
  }
  return redirect(url.pathname, { headers: noStoreHeaders });
}

export function headers() {
  return noStoreHeaders;
}

export function meta() {
  return [{ title: "Your personal workspace for an app · Leyway" }];
}

export default function BackofficeAppMemberReach({
  loaderData: page,
  actionData,
}: Pick<Route.ComponentProps, "loaderData" | "actionData">) {
  const navigation = useNavigation();
  const pending = navigation.state !== "idle";
  const { appName } = page;
  const organizationName = page.organization.name;
  const { installation, consent } = page;
  const allowed = consent?.forInstallation === true;
  const mayAllow = page.appAsks && installation !== null && !allowed;

  return (
    <AuthorizationScreen
      title={`Let ${appName} into your personal workspace for ${organizationName}`}
      description={`When ${appName} acts for you in ${organizationName}, it can also act in your personal workspace, such as using your connections.`}
      eyebrow="Leyway apps"
    >
      <div className="space-y-4">
        <p className="text-sm text-[var(--bo-muted)]">
          Signed in as <strong className="text-[var(--bo-fg)]">{page.userEmail}</strong>
        </p>
        <p className="text-sm leading-6 text-pretty text-[var(--bo-muted)]">
          {organizationName} decides what {appName} may do; there, it may do the same in your
          personal workspace, and only when it acts for you. The work it does for you runs in
          {organizationName}, not in your personal workspace: people there who can see that work can
          read what it finds in your workspace, such as what your connections return, and people who
          can change it can make it act there. You can stop this at any time, and work already
          running stops at once.
        </p>
        {installation && !installation.organizationAllows && (allowed || mayAllow) ? (
          <p className="text-sm text-[var(--bo-muted)]">
            {organizationName} does not let {appName} ask its members now, so until it does, letting
            it in changes nothing.
          </p>
        ) : null}
        {allowed ? (
          <p className="text-sm text-[var(--bo-muted)]">
            Allowed since{" "}
            <time dateTime={consent.allowedAt}>
              {ALLOWED_AT_FORMATTER.format(new Date(consent.allowedAt))}
            </time>
            .
            {page.appAsks
              ? null
              : ` ${appName} no longer asks for this, but it can act here until you stop it.`}
          </p>
        ) : null}
        {consent && !allowed ? (
          <p className="text-sm text-[var(--bo-muted)]">
            You let an earlier installation of {appName} in; it no longer applies.
          </p>
        ) : null}
        {actionData ? (
          <p role="alert" className="text-sm text-[var(--bo-failed)]">
            {actionData.message}
          </p>
        ) : null}
        <Form method="post" className="flex flex-col gap-2 sm:flex-row">
          {mayAllow ? (
            <>
              <input type="hidden" name="activation" value={installation.activation} />
              <Button variant="accent" type="submit" name="intent" value="allow" disabled={pending}>
                Allow
              </Button>
            </>
          ) : null}
          {consent ? (
            <Button variant="danger" type="submit" name="intent" value="stop" disabled={pending}>
              Stop allowing
            </Button>
          ) : null}
        </Form>
      </div>
    </AuthorizationScreen>
  );
}

const ALLOWED_AT_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <AuthorizationScreen
      title="Personal workspace access unavailable"
      description="Return to the application and try again."
      eyebrow="Leyway apps"
    >
      <p role="alert" className="text-sm text-[var(--bo-failed)]">
        {isRouteErrorResponse(error) && typeof error.data === "string"
          ? error.data
          : "This page could not be loaded."}
      </p>
    </AuthorizationScreen>
  );
}
