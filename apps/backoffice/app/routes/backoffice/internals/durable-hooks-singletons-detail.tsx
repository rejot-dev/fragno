import type { ReactNode } from "react";
import { Link, useLocation, useOutletContext, useParams } from "react-router";

import type { DurableHookQueueEntry } from "@/fragno/durable-hooks";

import { formatPayload, formatTimestamp, getStatusBadgeClasses } from "./durable-hooks-shared";
import type { DurableHooksSingletonOutletContext } from "./durable-hooks-singletons";

export default function BackofficeDurableHooksSingletonDetailRoute() {
  const { hooks } = useOutletContext<DurableHooksSingletonOutletContext>();
  const params = useParams();
  const location = useLocation();
  const selectedHookId = params.hookId ?? null;
  const hook = hooks.find((item) => item.id === selectedHookId) ?? null;

  if (!hook) {
    return (
      <div className="text-sm text-[var(--bo-muted)]">
        Select a durable hook to review its payload and error details.
      </div>
    );
  }

  const basePath = "/backoffice/internals/durable-hooks/singletons";
  const backToListHref = `${basePath}${location.search}`;

  return <DurableHookDetailPanel hook={hook} backToListHref={backToListHref} />;
}

export function DurableHookDetailPanel({
  hook,
  backToListHref,
}: {
  hook: DurableHookQueueEntry;
  backToListHref?: string;
}) {
  const payloadText = formatPayload(hook.payload);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Durable hook
          </p>
          <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">{hook.hookName}</h3>
          <p className="text-xs text-[var(--bo-muted-2)]">Hook ID: {hook.id}</p>
        </div>
        {backToListHref ? (
          <Link
            to={backToListHref}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] lg:hidden"
          >
            Back to queue
          </Link>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <DetailItem
          label="Status"
          value={
            <span
              className={`inline-flex border px-2 py-1 text-[10px] tracking-[0.22em] uppercase ${getStatusBadgeClasses(hook.status)}`}
            >
              {hook.status}
            </span>
          }
        />
        <DetailItem label="Attempts" value={`${hook.attempts} / ${hook.maxAttempts}`} />
        <DetailItem
          label="Last attempt"
          value={formatTimestamp(hook.lastAttemptAt) || "Not attempted"}
        />
        <DetailItem
          label="Next retry"
          value={formatTimestamp(hook.nextRetryAt) || "Not scheduled"}
        />
        <DetailItem label="Created" value={formatTimestamp(hook.createdAt) || "Unknown"} />
        <DetailItem label="Hook name" value={hook.hookName} />
      </div>

      {hook.error ? (
        <div className="border border-red-200 bg-red-50 p-3 text-sm text-red-600">{hook.error}</div>
      ) : (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          No error recorded for this hook.
        </div>
      )}

      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
        <div className="border-b border-[color:var(--bo-border)] px-3 py-2">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Payload
          </p>
        </div>
        <pre className="max-h-[360px] overflow-auto p-3 text-xs text-[var(--bo-fg)]">
          {payloadText || "No payload recorded."}
        </pre>
      </div>
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
      <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">{label}</p>
      <div className="mt-2 text-sm text-[var(--bo-fg)]">{value}</div>
    </div>
  );
}
