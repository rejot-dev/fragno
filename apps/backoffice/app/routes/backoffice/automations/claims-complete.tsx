import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { Form, useNavigation } from "react-router";

import { findBackofficeMe } from "@/fragno/auth/auth-server";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { getOtpDurableObject } from "@/worker-runtime/durable-objects";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/claims-complete";

/** GET displays the persisted identity without consuming its claim or granting authority. */
export async function loader({ request, context, params, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me) {
    throw Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }
  const organization = me.organizations.find(
    (entry) => entry.organization.slug === params.orgSlug,
  )?.organization;
  if (!organization) {
    throw new Response("Not Found", { status: 404 });
  }
  const externalId = url.searchParams.get("externalId")?.trim() ?? "";
  const code = url.searchParams.get("code")?.trim() ?? "";
  const claim = await getOtpDurableObject(context, organization.id).commands.getIdentityClaim({
    externalId,
    code,
  });
  return {
    organization: { id: organization.id, slug: organization.slug, name: organization.name },
    claim,
    externalId,
    code,
  };
}

/** Explicit same-origin confirmation links only the authenticated user in the owning organization. */
export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new Response("Identity confirmation requires a same-origin POST.", { status: 403 });
  }
  const me = await findBackofficeMe(request, context);
  if (!me) {
    throw new Response("Authentication required", { status: 401 });
  }
  const organization = me.organizations.find(
    (entry) => entry.organization.slug === params.orgSlug,
  )?.organization;
  if (!organization) {
    throw new Response("Not Found", { status: 404 });
  }
  const execution = await requireBackofficeContext(request, context, {
    kind: "org",
    orgId: organization.id,
  });
  const form = await request.formData();
  if (form.get("confirm") !== "link") {
    throw new Response("Explicit identity confirmation required", { status: 400 });
  }
  const externalId = form.get("externalId");
  const code = form.get("code");
  if (typeof externalId !== "string" || typeof code !== "string") {
    throw new Response("Invalid claim details", { status: 400 });
  }
  const result = await getOtpDurableObject(context, organization.id).commands.confirmIdentityClaim(
    { externalId, code },
    execution,
  );
  return result.ok
    ? { ok: true, message: "Your identity link confirmation was recorded." }
    : {
        ok: false,
        message: "This link is invalid or expired. Ask the source app to send a fresh link.",
      };
}

export function headers() {
  return { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
}

export function meta() {
  return [{ title: "Confirm identity link" }];
}

export default function BackofficeAutomationClaimComplete({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();
  const message =
    actionData?.message ??
    (loaderData.claim
      ? "Only link this external account if it belongs to you. It may act on your behalf through organization automations."
      : "This link is invalid or expired. Ask the source app to send a fresh link.");
  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Automations" }]}
        eyebrow="Automations"
        title={actionData?.ok ? "Identity link confirmed" : "Confirm identity link"}
        description={`Organization: ${loaderData.organization.name}`}
      />
      <FormContainer
        title="Link an external account"
        eyebrow="Identity"
        description={message}
        actions={
          <ButtonLink
            variant="secondary"
            to={`/backoffice/organizations/${encodeURIComponent(loaderData.organization.slug)}`}
          >
            Back to organization
          </ButtonLink>
        }
      >
        {loaderData.claim && !actionData?.ok ? (
          <Form method="post" className="space-y-4">
            <p>
              {loaderData.claim.actor.source} / {loaderData.claim.actor.type}:{" "}
              {loaderData.claim.actor.id}
            </p>
            <input type="hidden" name="externalId" value={loaderData.externalId} />
            <input type="hidden" name="code" value={loaderData.code} />
            <Button
              variant="accent"
              type="submit"
              name="confirm"
              value="link"
              disabled={navigation.state !== "idle"}
            >
              Link to my account
            </Button>
          </Form>
        ) : (
          <p>{message}</p>
        )}
      </FormContainer>
    </div>
  );
}
