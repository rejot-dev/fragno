import "@fragno-private/design-system/components.css";

import { Button, ButtonLink } from "@fragno-private/design-system/controls/button";
import { Callout } from "@fragno-private/design-system/feedback/callout";
import type { BackofficeStatusTone } from "@fragno-private/design-system/feedback/status-tone";
import { Icon, type IconName } from "@fragno-private/design-system/icon";
import { StandalonePageAccount } from "@fragno-private/design-system/layout/standalone-page";
import type { ReactNode } from "react";
import {
  data,
  Form,
  isRouteErrorResponse,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { z } from "zod";

import { callBetterAuth } from "@/fragno/auth/auth-server";
import { requireBackofficeBrowserSession } from "@/fragno/auth/browser-session.server";
import { useBackofficeSignOut } from "@/fragno/auth/use-backoffice-sign-out";
import { BackofficeStandaloneLayout } from "@/layouts/backoffice-standalone-layout";
import { getAuthDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/device";

const AUTHORIZED_APPLICATIONS_PATH = "/backoffice/settings/authorized-applications";
const noStoreHeaders = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

const deviceUserCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
const deviceAuthorizationSchema = z.object({
  user_code: z.string().min(1),
  status: z.string().min(1),
  client_id: z.string().min(1),
  scope: z.string().default(""),
});
const deviceActionInputSchema = z.object({
  // Switching accounts denies the request: Better Auth binds a code to the first account that
  // opens it, so the next account must start a new sign-in.
  intent: z.enum(["approve", "deny", "switch-account"]),
});

type BackofficeDeviceLoaderData = {
  account: { name: string; email: string };
  /** `firstParty` is the deployment's own client, which acts as the person everywhere. */
  client: { name: string; firstParty: boolean };
  userCode: string;
  scopes: string[];
};

type BackofficeDeviceActionData =
  | { status: "denied" }
  | { status: "switching-account" }
  | { status: "error"; message: string };

async function loadBackofficeDeviceAuthorization(
  request: Request,
  context: Route.LoaderArgs["context"],
  url: URL,
): Promise<BackofficeDeviceLoaderData> {
  const userCode = deviceUserCodeSchema.safeParse(url.searchParams.get("user_code"));
  if (!userCode.success) {
    throw new Response("A valid device user code is required.", { status: 400 });
  }

  const user = await requireBackofficeBrowserSession({ request, context, url });

  const deviceResponse = await callBetterAuth(
    request,
    context,
    `/device?user_code=${encodeURIComponent(userCode.data)}`,
  );
  if (!deviceResponse.ok) {
    throw new Response("This device authorization request is invalid or expired.", {
      status: 400,
    });
  }

  const deviceAuthorization = deviceAuthorizationSchema.safeParse(await deviceResponse.json());
  if (!deviceAuthorization.success) {
    throw new Response("This device authorization request is invalid or expired.", {
      status: 400,
    });
  }
  const client = await getAuthDurableObject(context).commands.getOAuthClientFacts({
    clientId: deviceAuthorization.data.client_id,
  });
  if (client === null || client.disabled) {
    throw new Response("The application asking to sign in is not available.", { status: 400 });
  }

  return {
    account: { name: user.name, email: user.email },
    client: { name: client.name ?? client.clientId, firstParty: client.managedByBackoffice },
    userCode: userCode.data,
    scopes: deviceAuthorization.data.scope.split(/\s+/).filter(Boolean),
  };
}

export async function loader({ request, context, url }: Route.LoaderArgs) {
  return await loadBackofficeDeviceAuthorization(request, context, url);
}

export async function action({ request, context, url }: Route.ActionArgs) {
  const formData = await request.formData();
  const input = deviceActionInputSchema.safeParse(Object.fromEntries(formData));
  if (!input.success) {
    return data(
      {
        status: "error",
        message: "Choose whether to approve or deny this request.",
      } satisfies BackofficeDeviceActionData,
      { status: 400 },
    );
  }

  const authorization = await loadBackofficeDeviceAuthorization(request, context, url);
  const endpoint = input.data.intent === "approve" ? "/device/approve" : "/device/deny";
  const response = await callBetterAuth(request, context, endpoint, {
    method: "POST",
    body: JSON.stringify({ userCode: authorization.userCode }),
  });
  if (!response.ok) {
    const error = await response.json<{
      error_description?: string;
      message?: string;
    }>();
    return data(
      {
        status: "error",
        message: error?.error_description ?? error?.message ?? "Unable to update this request.",
      } satisfies BackofficeDeviceActionData,
      { status: response.status },
    );
  }

  // An approved application is listed among the authorized ones, where it can be revoked.
  if (input.data.intent === "approve") {
    return redirect(AUTHORIZED_APPLICATIONS_PATH, { headers: noStoreHeaders });
  }
  if (input.data.intent === "switch-account") {
    return { status: "switching-account" } satisfies BackofficeDeviceActionData;
  }
  return { status: "denied" } satisfies BackofficeDeviceActionData;
}

export function headers() {
  return noStoreHeaders;
}

export function meta() {
  return [
    { title: "Authorize device · Leyway" },
    { name: "description", content: "Approve an application signing in from another device." },
  ];
}

/**
 * What the requested scopes let the application do, most consequential first; an undescribed scope
 * keeps its name. Only the deployment's own client acts everywhere: any other acts only through an
 * app an organization installed.
 */
function describeDeviceScopes(
  scopes: readonly string[],
  firstParty: boolean,
): { scope: string; description: string | null }[] {
  const descriptions = [
    [
      "backoffice",
      firstParty
        ? "Act as you in your workspace and every organization you belong to"
        : "Act as you in organizations that installed its app",
    ],
    ["offline_access", "Stay signed in until you revoke it"],
    ["openid", "See your name and email address"],
  ] as const;
  const known = descriptions.filter(([scope]) => scopes.includes(scope));
  const unknown = scopes.filter((scope) => !known.some(([described]) => described === scope));
  return [
    ...known.map(([scope, description]) => ({ scope, description })),
    ...unknown.map((scope) => ({ scope, description: null })),
  ];
}

export default function BackofficeDeviceAuthorization() {
  const authorization = useLoaderData<BackofficeDeviceLoaderData>();
  const actionData = useActionData<BackofficeDeviceActionData>();

  const { email } = authorization.account;
  const { name } = authorization.client;

  if (actionData?.status === "denied") {
    return (
      <BackofficeStandaloneLayout
        headerEnd={
          <StandalonePageAccount email={email} signOut={<DeviceSignOut variant="ghost" />} />
        }
      >
        <DeviceColumn>
          <DeviceOutcome
            tone="muted"
            icon="x"
            title="Sign-in denied"
            description={`${name} was not signed in and received no access. You can close this page.`}
          />
        </DeviceColumn>
      </BackofficeStandaloneLayout>
    );
  }
  if (actionData?.status === "switching-account") {
    return (
      <BackofficeStandaloneLayout
        headerEnd={
          <StandalonePageAccount email={email} signOut={<DeviceSignOut variant="ghost" />} />
        }
      >
        <DeviceColumn>
          <DeviceOutcome
            tone="muted"
            icon="log-out"
            title="Start the sign-in again"
            description={`Opening this request linked it to ${email}, so it was cancelled. Sign out, sign in with the account you want, then start the sign-in again on your device.`}
          />
          <div>
            <DeviceSignOut variant="accent" />
          </div>
        </DeviceColumn>
      </BackofficeStandaloneLayout>
    );
  }
  return (
    <BackofficeStandaloneLayout
      headerEnd={
        <StandalonePageAccount
          email={email}
          signOut={
            <Form method="post">
              <Button variant="ghost" type="submit" name="intent" value="switch-account">
                Use another account
              </Button>
            </Form>
          }
        />
      }
    >
      <DeviceColumn>
        <DeviceReview
          authorization={authorization}
          error={actionData?.status === "error" ? actionData.message : null}
        />
      </DeviceColumn>
    </BackofficeStandaloneLayout>
  );
}

function DeviceColumn({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-5 py-10">
      {children}
    </div>
  );
}

function DeviceSignOut({ variant }: { variant: "ghost" | "accent" }) {
  const { signOut, signingOut } = useBackofficeSignOut();
  return (
    <Button variant={variant} type="button" disabled={signingOut} onClick={signOut}>
      {signingOut ? "Signing out…" : "Sign out"}
    </Button>
  );
}

function DeviceReview({
  authorization,
  error,
}: {
  authorization: BackofficeDeviceLoaderData;
  error: string | null;
}) {
  const navigation = useNavigation();
  const pending = navigation.state !== "idle";
  const { account, client } = authorization;
  // Better Auth keeps an empty name for people who never gave one.
  const displayName = account.name.trim() || account.email;

  return (
    <>
      <DeviceHeading
        title={`Sign in to ${client.name}?`}
        description={`${client.name} on another device is asking to sign in to your account.`}
      />
      <section
        aria-label="Sign-in request"
        className="bo-panel-surface rounded-[6px] bg-[var(--bo-panel)]"
      >
        <div className="flex items-center gap-3 p-4">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-[6px] bg-[var(--primary)] text-base font-semibold text-[var(--primary-foreground)]"
          >
            {displayName.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <DeviceCaption>Signing in as</DeviceCaption>
            <p className="mt-0.5 truncate text-base font-semibold text-[var(--bo-fg)]">
              {displayName}
            </p>
            {displayName === account.email ? null : (
              <p className="truncate text-sm text-[var(--bo-muted)]">{account.email}</p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-t border-[color:var(--bo-border)] p-4">
          <div>
            <DeviceCaption>Code</DeviceCaption>
            <p className="mt-1 font-mono text-2xl tracking-[0.18em] text-[var(--bo-fg)] tabular-nums">
              {authorization.userCode}
            </p>
          </div>
          <p className="max-w-56 text-xs leading-5 text-pretty text-[var(--bo-muted)]">
            Check that it matches the code on your device.
          </p>
        </div>
        <div className="border-t border-[color:var(--bo-border)] p-4">
          <DeviceCaption>{`${client.name} will be able to`}</DeviceCaption>
          <ul className="mt-2 space-y-2 text-sm text-[var(--bo-fg)]">
            {describeDeviceScopes(authorization.scopes, client.firstParty).map(
              ({ scope, description }) => (
                <li key={scope} className="flex gap-2">
                  <Icon
                    name="check"
                    className="mt-0.5 size-4 shrink-0 text-[var(--bo-accent-text)]"
                    strokeWidth={2.25}
                  />
                  {description ?? <span className="font-mono">{scope}</span>}
                </li>
              ),
            )}
          </ul>
        </div>
      </section>
      <Callout tone="waiting" title="Only approve your own sign-in">
        Anyone can send you a sign-in link. If you did not just start this sign-in yourself, deny
        this request.
      </Callout>
      {error === null ? null : (
        <Callout tone="failed" title="Request not updated">
          {error}
        </Callout>
      )}
      <Form method="post" className="flex flex-col gap-2 sm:flex-row">
        <Button variant="accent" type="submit" name="intent" value="approve" disabled={pending}>
          {pending ? "Updating…" : "Approve sign-in"}
        </Button>
        <Button variant="secondary" type="submit" name="intent" value="deny" disabled={pending}>
          Deny
        </Button>
      </Form>
      <p className="text-xs leading-5 text-[var(--bo-muted-2)]">
        Review or revoke access in{" "}
        <Link
          to={AUTHORIZED_APPLICATIONS_PATH}
          className="underline underline-offset-4 hover:text-[var(--bo-fg)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--bo-accent)]"
        >
          Settings → Authorized applications
        </Link>
        .
      </p>
    </>
  );
}

function DeviceOutcome({
  tone,
  icon,
  title,
  description,
}: {
  tone: BackofficeStatusTone;
  icon: IconName;
  title: string;
  description: ReactNode;
}) {
  return (
    <>
      <span
        data-tone={tone}
        className="bo-status-tone bo-status-surface flex size-11 items-center justify-center rounded-full border"
      >
        <Icon name={icon} className="size-5" strokeWidth={2.25} />
      </span>
      <DeviceHeading title={title} description={description} />
    </>
  );
}

function DeviceHeading({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div className="space-y-2">
      <h1 className="text-3xl leading-tight font-semibold text-balance">{title}</h1>
      <p className="text-sm leading-6 text-pretty text-[var(--bo-muted)]">{description}</p>
    </div>
  );
}

function DeviceCaption({ children }: { children: ReactNode }) {
  return (
    <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">{children}</p>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <BackofficeStandaloneLayout
      headerEnd={
        <ButtonLink variant="ghost" to="/backoffice">
          Go to dashboard
        </ButtonLink>
      }
    >
      <DeviceColumn>
        <DeviceOutcome
          tone="failed"
          icon="alert-triangle"
          title="This sign-in link no longer works"
          description={`${
            isRouteErrorResponse(error) && typeof error.data === "string"
              ? error.data
              : "This sign-in request could not be loaded."
          } Start the sign-in again on your device for a new code.`}
        />
      </DeviceColumn>
    </BackofficeStandaloneLayout>
  );
}
