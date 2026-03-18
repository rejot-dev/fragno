import { Link, useLoaderData, useOutletContext, useParams } from "react-router";

import type { ResendDomainRecord } from "@fragno-dev/resend-fragment";

import type { Route } from "./+types/domain-detail";
import { fetchResendDomainDetail } from "./data";
import type { ResendDomainsOutletContext } from "./domains";
import {
  formatResendCapability,
  formatResendDomainStatus,
  formatTimestamp,
  getResendDomainStatusTone,
} from "./shared";

type ResendDomainDetailLoaderData = {
  domain: Awaited<ReturnType<typeof fetchResendDomainDetail>>["domain"];
  error: string | null;
};

const recordLabel = (record: ResendDomainRecord) => {
  if (record.record === "Receiving") {
    return "Receiving MX";
  }
  return `${record.record} ${record.type}`;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId || !params.domainId) {
    throw new Response("Not Found", { status: 404 });
  }

  const result = await fetchResendDomainDetail(request, context, params.orgId, params.domainId);
  return {
    domain: result.domain,
    error: result.error,
  } satisfies ResendDomainDetailLoaderData;
}

export default function BackofficeOrganisationResendDomainDetail() {
  const { domain, error } = useLoaderData<typeof loader>();
  const { basePath } = useOutletContext<ResendDomainsOutletContext>();
  const { domainId } = useParams();

  if (!domainId || error || !domain) {
    return (
      <div className="space-y-3 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          Domain detail
        </p>
        <p>{error ?? "We could not load that domain."}</p>
        <Link
          to={basePath}
          className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Back to domains
        </Link>
      </div>
    );
  }

  const statusTone = getResendDomainStatusTone(domain.status);
  const receivingRecords = domain.records.filter((record) => record.record === "Receiving");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">Domain</p>
          <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">{domain.name}</h3>
          <p className="text-xs text-[var(--bo-muted-2)]">ID: {domain.id}</p>
        </div>
        <Link
          to={basePath}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] lg:hidden"
        >
          Back to domains
        </Link>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Status</p>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`border px-2 py-1 text-[10px] tracking-[0.22em] uppercase ${statusTone}`}
            >
              {formatResendDomainStatus(domain.status)}
            </span>
            <span className="text-xs text-[var(--bo-muted-2)]">{domain.region}</span>
          </div>
          <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
            Added <span className="text-[var(--bo-fg)]">{formatTimestamp(domain.createdAt)}</span>
          </p>
        </section>

        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Capabilities
          </p>
          <div className="mt-2 space-y-2 text-xs text-[var(--bo-muted-2)]">
            <p>
              Sending:{" "}
              <span className="text-[var(--bo-fg)]">
                {formatResendCapability(domain.capabilities.sending)}
              </span>
            </p>
            <p>
              Receiving:{" "}
              <span className="text-[var(--bo-fg)]">
                {formatResendCapability(domain.capabilities.receiving)}
              </span>
            </p>
            <p>
              DNS records: <span className="text-[var(--bo-fg)]">{domain.records.length}</span>
            </p>
          </div>
        </section>
      </div>

      {receivingRecords.length > 0 ? (
        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Receiving setup
          </p>
          <div className="mt-3 space-y-2">
            {receivingRecords.map((record, index) => (
              <article
                key={`${record.name}-${record.value}-${index}`}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-[var(--bo-fg)]">{record.name}</p>
                    <p className="mt-1 text-xs text-[var(--bo-muted-2)]">{record.value}</p>
                  </div>
                  <span
                    className={`border px-2 py-1 text-[9px] tracking-[0.22em] uppercase ${getResendDomainStatusTone(record.status)}`}
                  >
                    {formatResendDomainStatus(record.status)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--bo-muted-2)]">
                  <span>{record.type}</span>
                  {record.priority !== undefined ? <span>· Priority {record.priority}</span> : null}
                  <span>· TTL {record.ttl}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            DNS records
          </p>
          <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
            {domain.records.length} total
          </span>
        </div>

        <div className="mt-3 space-y-2">
          {domain.records.map((record, index) => (
            <article
              key={`${record.record}-${record.name}-${record.value}-${index}`}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-[var(--bo-fg)]">{recordLabel(record)}</p>
                  <p className="mt-1 text-xs text-[var(--bo-muted-2)]">{record.name}</p>
                </div>
                <span
                  className={`border px-2 py-1 text-[9px] tracking-[0.22em] uppercase ${getResendDomainStatusTone(record.status)}`}
                >
                  {formatResendDomainStatus(record.status)}
                </span>
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Value
                  </p>
                  <p className="mt-1 text-xs break-all text-[var(--bo-fg)]">{record.value}</p>
                </div>
                <div>
                  <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Metadata
                  </p>
                  <div className="mt-1 space-y-1 text-xs text-[var(--bo-muted-2)]">
                    <p>
                      Type: <span className="text-[var(--bo-fg)]">{record.type}</span>
                    </p>
                    <p>
                      TTL: <span className="text-[var(--bo-fg)]">{record.ttl}</span>
                    </p>
                    {record.priority !== undefined ? (
                      <p>
                        Priority: <span className="text-[var(--bo-fg)]">{record.priority}</span>
                      </p>
                    ) : null}
                    {record.routingPolicy ? (
                      <p>
                        Routing policy:{" "}
                        <span className="text-[var(--bo-fg)]">{record.routingPolicy}</span>
                      </p>
                    ) : null}
                    {record.proxyStatus ? (
                      <p>
                        Proxy status:{" "}
                        <span className="text-[var(--bo-fg)]">{record.proxyStatus}</span>
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
