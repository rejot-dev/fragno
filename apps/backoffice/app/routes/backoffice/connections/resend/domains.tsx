import { Link, Outlet, redirect, useLoaderData, useOutletContext, useParams } from "react-router";

import type { ResendDomain } from "@fragno-dev/resend-fragment";

import type { Route } from "./+types/domains";
import { fetchResendConfig, fetchResendDomains } from "./data";
import {
  formatResendCapability,
  formatResendDomainStatus,
  formatTimestamp,
  getResendDomainStatusTone,
  type ResendLayoutContext,
} from "./shared";

type ResendDomainsLoaderData = {
  configError: string | null;
  domainsError: string | null;
  domains: ResendDomain[];
  hasMore: boolean;
};

export type ResendDomainsOutletContext = {
  domains: ResendDomain[];
  selectedDomainId: string | null;
  basePath: string;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const { configState, configError } = await fetchResendConfig(context, params.orgId);
  if (configError) {
    return {
      configError,
      domainsError: null,
      domains: [],
      hasMore: false,
    } satisfies ResendDomainsLoaderData;
  }

  if (!configState?.configured) {
    return redirect(`/backoffice/connections/resend/${params.orgId}/configuration`);
  }

  const { domains, hasMore, domainsError } = await fetchResendDomains(
    request,
    context,
    params.orgId,
  );
  return {
    configError: null,
    domainsError,
    domains,
    hasMore,
  } satisfies ResendDomainsLoaderData;
}

export default function BackofficeOrganisationResendDomains() {
  const { domains, hasMore, configError, domainsError } = useLoaderData<typeof loader>();
  const { orgId } = useOutletContext<ResendLayoutContext>();
  const { domainId } = useParams();
  const selectedDomainId = domainId ?? null;
  const basePath = `/backoffice/connections/resend/${orgId}/domains`;
  const isDetailRoute = Boolean(selectedDomainId);

  if (configError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{configError}</div>
    );
  }

  if (domainsError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{domainsError}</div>
    );
  }

  if (!domains.length) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        No domains available for this Resend API key yet.
      </div>
    );
  }

  const listVisibility = isDetailRoute ? "hidden lg:block" : "block";
  const detailVisibility = isDetailRoute ? "block" : "hidden lg:block";

  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_1.35fr]">
      <div
        className={`${listVisibility} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Domains
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Configured domains</h2>
          </div>
          <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
            {domains.length} shown
          </span>
        </div>

        <div className="mt-4 space-y-2">
          {domains.map((domain) => {
            const isSelected = domain.id === selectedDomainId;
            const statusTone = getResendDomainStatusTone(domain.status);
            return (
              <Link
                key={domain.id}
                to={`${basePath}/${domain.id}`}
                aria-current={isSelected ? "page" : undefined}
                className={
                  isSelected
                    ? "block w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-left text-[var(--bo-accent-fg)]"
                    : "block w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-left text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)]"
                }
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[var(--bo-fg)]">{domain.name}</p>
                    <p className="mt-1 text-xs text-[var(--bo-muted-2)]">
                      {domain.region} · Added {formatTimestamp(domain.createdAt)}
                    </p>
                  </div>
                  <span
                    className={`border px-2 py-1 text-[9px] tracking-[0.22em] uppercase ${statusTone}`}
                  >
                    {formatResendDomainStatus(domain.status)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--bo-muted-2)]">
                  <span>Sending {formatResendCapability(domain.capabilities.sending)}</span>
                  <span>·</span>
                  <span>Receiving {formatResendCapability(domain.capabilities.receiving)}</span>
                </div>
              </Link>
            );
          })}
        </div>

        {hasMore ? (
          <p className="mt-4 text-xs text-[var(--bo-muted-2)]">
            Showing the first 100 domains returned by Resend.
          </p>
        ) : null}
      </div>

      <div
        className={`${detailVisibility} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <Outlet
          context={{
            domains,
            selectedDomainId,
            basePath,
          }}
        />
      </div>
    </section>
  );
}
