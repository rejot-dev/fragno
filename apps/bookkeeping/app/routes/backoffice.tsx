import { Button } from "@fragno-private/design-system/button";
import { FormContainer, FormField } from "@fragno-private/design-system/form-container";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, redirect, useFetcher, useNavigation } from "react-router";

import { authClient } from "../lib/auth-client";
import {
  linkTargets,
  sendConnectionTestEvent,
  startBackofficeInstall,
  targetKey,
  type BackofficeTarget,
} from "../lib/backoffice.server";
import { requireSession } from "../lib/session.server";
import type { Route } from "./+types/backoffice";

export function meta() {
  return [{ title: "Backoffice · Bookkeeping" }];
}

function targetLabel(target: BackofficeTarget): string {
  return target.kind === "org" ? "Whole organization" : `Project ${target.projectId}`;
}

async function hasLinkedBackofficeAccount(request: Request): Promise<boolean> {
  const response = await env.AUTH.getByName("auth").fetch(
    new Request(new URL("/api/auth/list-accounts", env.BOOKKEEPING_BASE_URL), {
      headers: { cookie: request.headers.get("cookie") ?? "" },
    }),
  );
  if (!response.ok) {
    throw new Response("Could not load your connections. Please try again.", { status: 503 });
  }
  const accounts = (await response.json()) as { providerId: string }[];
  return accounts.some(({ providerId }) => providerId === "backoffice");
}

export async function loader({ request, url }: Route.LoaderArgs) {
  await requireSession(request);
  const auth = env.AUTH.getByName("auth");
  const active = await auth.getActiveOrganization(request.headers.get("cookie") ?? "");
  const link = active ? await auth.getBackofficeLink(active.organization.id) : null;
  return {
    organization: active ? { name: active.organization.name, canManage: active.canManage } : null,
    link: link
      ? {
          backofficeOrganizationId: link.backofficeOrganizationId,
          targets: linkTargets(link).map((target) => ({
            key: targetKey(target),
            label: targetLabel(target),
          })),
        }
      : null,
    accountLinked: await hasLinkedBackofficeAccount(request),
    outcome: {
      link: url.searchParams.get("link"),
      message: url.searchParams.get("message"),
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireSession(request);
  // Session cookies are SameSite=Lax; this also rejects same-site cross-origin submissions.
  if (request.headers.get("origin") !== new URL(env.BOOKKEEPING_BASE_URL).origin) {
    throw new Response("Cross-origin submissions are not allowed.", { status: 403 });
  }
  const form = await request.formData();
  const auth = env.AUTH.getByName("auth");
  const cookie = request.headers.get("cookie") ?? "";
  const intent = form.get("intent");

  if (intent === "connect") {
    const location = await startBackofficeInstall(request);
    if (!location) {
      return {
        status: "rejected",
        message: "Only an owner or admin of this organization can connect Backoffice.",
      } as const;
    }
    return redirect(location);
  }
  if (intent === "disconnect") {
    return (await auth.removeBackofficeLink(cookie))
      ? redirect("/dashboard/backoffice")
      : ({
          status: "rejected",
          message: "Only an owner or admin of this organization can disconnect Backoffice.",
        } as const);
  }

  const active = await auth.getActiveOrganization(cookie);
  const link = active ? await auth.getBackofficeLink(active.organization.id) : null;
  if (!active || !link) {
    return { status: "not-linked" } as const;
  }
  const target = linkTargets(link).find((candidate) => targetKey(candidate) === form.get("target"));
  if (!target) {
    return { status: "rejected", message: "Choose one of the approved targets." } as const;
  }
  const actor = intent === "send-as-user" ? "user" : "organization";
  return await sendConnectionTestEvent(request, { active, link, actor, target });
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

function AuthorizeBackofficeButton({ linked }: { linked: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        variant="secondary"
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          const callbackURL = "/dashboard/backoffice";
          try {
            // Signing in again refreshes an existing link's tokens and consent; linking adds one.
            const result = linked
              ? await authClient.signIn.social({
                  provider: "backoffice",
                  callbackURL,
                  errorCallbackURL: callbackURL,
                })
              : await authClient.linkSocial({
                  provider: "backoffice",
                  callbackURL,
                  errorCallbackURL: callbackURL,
                });
            if (result.error) {
              setError("Could not open Backoffice. Please try again.");
              setPending(false);
            }
          } catch {
            setError("Could not connect. Please try again.");
            setPending(false);
          }
        }}
      >
        {pending
          ? "Opening Backoffice…"
          : linked
            ? "Reauthorize your Backoffice account"
            : "Connect your Backoffice account"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-[var(--bo-failed)]">
          {error}
        </p>
      )}
    </div>
  );
}

const linkOutcomeMessages: Record<string, string> = {
  linked: "Backoffice is connected.",
  cancelled: "Connecting Backoffice was cancelled.",
};

export default function BackofficeConnection({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data ?? actionData;
  const sending = fetcher.state !== "idle";
  const { organization, link, outcome } = loaderData;

  if (!organization) {
    return (
      <div className="space-y-6">
        <BackofficePageHeader
          title="Backoffice"
          description="Connect an organization to Backoffice."
          breadcrumbs={[{ label: "Bookkeeping", to: "/dashboard" }, { label: "Backoffice" }]}
        />
        <FormContainer
          title="Choose an organization"
          description="Backoffice connects to a Bookkeeping organization. Create or select one first."
        >
          <Link to="/dashboard/organizations" className="text-sm underline underline-offset-4">
            Go to organizations
          </Link>
        </FormContainer>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title="Backoffice"
        description={`Connect ${organization.name} to a Backoffice organization and send it events.`}
        breadcrumbs={[{ label: "Bookkeeping", to: "/dashboard" }, { label: "Backoffice" }]}
      />
      <div className="max-w-2xl space-y-6">
        {outcome.link ? (
          <p
            role="status"
            className={outcome.link === "failed" ? "text-sm text-[var(--bo-failed)]" : "text-sm"}
          >
            {linkOutcomeMessages[outcome.link] ??
              outcome.message ??
              "Connecting Backoffice failed."}
          </p>
        ) : null}
        <FormContainer
          title="Organization connection"
          description="An owner or admin installs Bookkeeping in Backoffice and chooses what it may do there."
          actions={
            <BackofficeStatusLight tone={link ? "live" : "muted"}>
              {link ? "Connected" : "Not connected"}
            </BackofficeStatusLight>
          }
        >
          {link ? (
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-[var(--bo-muted)]">Backoffice organization</dt>
                <dd className="mt-1 font-mono text-xs break-all">
                  {link.backofficeOrganizationId}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--bo-muted)]">Approved access</dt>
                <dd className="mt-1">{link.targets.map(({ label }) => label).join(", ")}</dd>
              </div>
            </dl>
          ) : null}
          {organization.canManage ? (
            <Form method="post" className="flex flex-wrap gap-2">
              <Button
                type="submit"
                name="intent"
                value="connect"
                variant={link ? "secondary" : "accent"}
                disabled={navigation.state !== "idle"}
              >
                {link ? "Change in Backoffice" : "Connect to Backoffice"}
              </Button>
              {link ? (
                <Button type="submit" name="intent" value="disconnect" variant="ghost">
                  Disconnect
                </Button>
              ) : null}
            </Form>
          ) : (
            <p className="text-sm text-[var(--bo-muted)]">
              Ask an owner or admin of {organization.name} to connect Backoffice.
            </p>
          )}
          {link ? (
            <p className="text-xs text-[var(--bo-muted)]">
              Disconnecting only forgets the link here. To revoke Bookkeeping's access, uninstall it
              in Backoffice.
            </p>
          ) : null}
        </FormContainer>
        {link ? (
          <FormContainer
            title="Send a test event"
            description="Sends one bookkeeping.connection.tested event. As the organization, Bookkeeping uses only its approved access; as you, it is also limited to what you may do in Backoffice."
          >
            <fetcher.Form method="post" className="space-y-4">
              <FormField label="Target">
                <select
                  name="target"
                  className="bo-input min-h-11 w-full px-3 py-2 text-sm"
                  defaultValue={link.targets[0]?.key}
                >
                  {link.targets.map((target) => (
                    <option key={target.key} value={target.key}>
                      {target.label}
                    </option>
                  ))}
                </select>
              </FormField>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  name="intent"
                  value="send-as-organization"
                  variant="accent"
                  disabled={sending}
                >
                  {sending ? "Sending…" : `Send as ${organization.name}`}
                </Button>
                <Button
                  type="submit"
                  name="intent"
                  value="send-as-user"
                  variant="secondary"
                  disabled={sending || !loaderData.accountLinked}
                >
                  Send as you
                </Button>
              </div>
            </fetcher.Form>
            {!loaderData.accountLinked ? (
              <div className="space-y-2 text-sm text-[var(--bo-muted)]">
                <p>To send as yourself, connect your own Backoffice account.</p>
                <AuthorizeBackofficeButton linked={false} />
              </div>
            ) : null}
            {!sending && result ? <ConnectionTestOutcome result={result} /> : null}
          </FormContainer>
        ) : null}
      </div>
    </div>
  );
}

function ConnectionTestOutcome({
  result,
}: {
  result: NonNullable<Route.ComponentProps["actionData"]>;
}) {
  return (
    <div role="status" className="space-y-2 text-sm">
      {result.status === "accepted" ? (
        <>
          <BackofficeStatusLight tone="live">Accepted</BackofficeStatusLight>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-[var(--bo-muted)]">Event ID</dt>
              <dd className="mt-1 font-mono text-xs break-all">{result.receipt.eventId}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--bo-muted)]">Source</dt>
              <dd className="mt-1 font-mono text-xs break-all">{result.receipt.source}</dd>
            </div>
          </dl>
        </>
      ) : result.status === "not-linked" ? (
        <p className="text-[var(--bo-failed)]">Connect Backoffice before sending events.</p>
      ) : result.status === "reauthorization-required" ? (
        <>
          <p className="text-[var(--bo-failed)]">
            {result.message} Reauthorize Backoffice, then try again.
          </p>
          <AuthorizeBackofficeButton linked />
        </>
      ) : result.status === "unconfirmed" ? (
        <p className="text-[var(--bo-failed)]">
          Delivery not confirmed. {result.message} Check Backoffice before sending again.
        </p>
      ) : (
        <p className="text-[var(--bo-failed)]">{result.message}</p>
      )}
    </div>
  );
}
