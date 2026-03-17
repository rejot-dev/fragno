import { Link, type RouterContextProvider } from "react-router";

import { getOtpDurableObject } from "@/cloudflare/cloudflare-utils";
import { BackofficePageHeader, FormContainer } from "@/components/backoffice";
import { getAuthMe } from "@/fragno/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";

type LoaderData = {
  ok: boolean;
  orgId: string;
  organisationName: string;
  message: string;
};

export async function loader({
  request,
  context,
  params,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: { orgId?: string };
}): Promise<LoaderData | Response> {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === params.orgId)?.organization ?? null;
  if (!organisation) {
    throw new Response("Not Found", { status: 404 });
  }

  const externalId = url.searchParams.get("externalId")?.trim() ?? "";
  const code = url.searchParams.get("code")?.trim() ?? "";

  if (!externalId || !code) {
    return {
      ok: false,
      orgId: params.orgId,
      organisationName: organisation.name,
      message: "This link is missing the claim details. Ask the source app to send a fresh link.",
    };
  }

  const otpDo = getOtpDurableObject(context, params.orgId);
  const result = await otpDo.confirmIdentityClaim({
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
      orgId: params.orgId,
      organisationName: organisation.name,
      message,
    };
  }

  return {
    ok: true,
    orgId: params.orgId,
    organisationName: organisation.name,
    message:
      "Your link was confirmed. The automation has everything it needs to finish the identity binding.",
  };
}

export function meta({ data }: { data?: LoaderData }) {
  return [{ title: data?.ok ? "Identity link confirmed" : "Identity link failed" }];
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
        description={`Organisation: ${loaderData.organisationName}`}
      />

      <FormContainer
        title={loaderData.ok ? "Confirmation recorded" : "Unable to confirm link"}
        eyebrow={loaderData.ok ? "Success" : "Error"}
        description={loaderData.message}
        actions={
          <Link
            to={`/backoffice/organisations/${loaderData.orgId}`}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Back to organisation
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
