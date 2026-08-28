import { Link } from "react-router";

import { BackofficePageHeader, FormContainer } from "@/components/backoffice";
import { findBackofficeMe } from "@/fragno/auth/auth-server";
import { getOtpDurableObject } from "@/worker-runtime/durable-objects";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/claims-complete";

type LoaderData = {
  ok: boolean;
  organization: { id: string; slug: string; name: string };
  message: string;
};

export async function loader({
  request,
  context,
  params,
  url,
}: Route.LoaderArgs): Promise<LoaderData | Response> {
  if (!params.orgSlug) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const organization =
    me.organizations.find((entry) => entry.organization.slug === params.orgSlug)?.organization ??
    null;
  if (!organization) {
    throw new Response("Not Found", { status: 404 });
  }

  const externalId = url.searchParams.get("externalId")?.trim() ?? "";
  const code = url.searchParams.get("code")?.trim() ?? "";

  if (!externalId || !code) {
    return {
      ok: false,
      organization: organization,
      message: "This link is missing the claim details. Ask the source app to send a fresh link.",
    };
  }

  const otpDo = getOtpDurableObject(context, organization.id);
  const result = await otpDo.commands.confirmIdentityClaim({
    externalId,
    code,
    subjectUserId: me.user.id,
  });

  if (!result.ok) {
    const message =
      result.error === "OTP_EXPIRED"
        ? "This link has expired. Ask the source app to send a fresh link."
        : result.error === "OTP_INVALID"
          ? "This link is invalid or has already been used. Ask the source app to send a new one."
          : "This link is incomplete. Ask the source app to send a fresh link.";

    return {
      ok: false,
      organization: organization,
      message,
    };
  }

  return {
    ok: true,
    organization: organization,
    message: "Your link was confirmed. Your account link is confirmed and active.",
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData?.ok ? "Identity link confirmed" : "Identity link failed" }];
}

export default function BackofficeAutomationClaimComplete({
  loaderData,
}: {
  loaderData: LoaderData;
}) {
  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Automations" }]}
        eyebrow="Automations"
        title={loaderData.ok ? "Identity link confirmed" : "Identity link failed"}
        description={`Organization: ${loaderData.organization.name}`}
      />

      <FormContainer
        title={loaderData.ok ? "Confirmation recorded" : "Unable to confirm link"}
        eyebrow={loaderData.ok ? "Success" : "Error"}
        description={loaderData.message}
        actions={
          <Link
            to={`/backoffice/organizations/${encodeURIComponent(loaderData.organization.slug)}`}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Back to organization
          </Link>
        }
      >
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 text-sm text-[var(--bo-muted)]">
          {loaderData.message}
        </div>
      </FormContainer>
    </div>
  );
}
