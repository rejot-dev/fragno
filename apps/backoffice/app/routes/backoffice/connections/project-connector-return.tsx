import "@fragno-private/design-system/components.css";

import { Link, useLoaderData } from "react-router";

import {
  backofficeRouteScopeFromSinglePathSegment,
  backofficeRouteScopePath,
} from "@/backoffice-runtime/route-scope";

import type { Route } from "./+types/project-connector-return";

/** Browser callback fields are not proof of consent; this public page never verifies or binds accounts. */
export function loader({ params }: Route.LoaderArgs) {
  try {
    const scope = backofficeRouteScopeFromSinglePathSegment(params.scopeSegment);
    if (scope.kind !== "user") {
      throw new Error("Connector returns require a user scope.");
    }
    return {
      backUrl: `/backoffice/automations/${backofficeRouteScopePath(scope)}`,
      scopeLabel: "Personal account",
    };
  } catch {
    throw new Response("Invalid connection return link", { status: 404 });
  }
}

export function meta() {
  return [{ title: "Connection authorization return · Backoffice" }];
}

export default function BackofficeProjectConnectorReturn() {
  const { backUrl, scopeLabel } = useLoaderData<typeof loader>();

  return (
    <div
      data-backoffice-root
      className="relative isolate min-h-dvh bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <div aria-hidden="true" className="bo-grid-backdrop pointer-events-none absolute inset-0" />
      <main className="relative mx-auto flex min-h-dvh w-full max-w-2xl items-center px-4 py-10 sm:px-6">
        <div className="w-full">
          <p className="mb-4 font-mono text-[11px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            Backoffice / Connector
          </p>
          <section
            aria-labelledby="connection-return-title"
            className="bo-panel-surface bo-fragment-surface border border-[color:var(--bo-border)] bg-[var(--bo-panel)]"
          >
            <div className="p-6 sm:p-8">
              <span
                aria-hidden="true"
                className="inline-flex size-12 items-center justify-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] font-mono text-2xl text-[var(--bo-fg)]"
              >
                ↩
              </span>
              <p className="mt-6 font-mono text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
                Browser return received
              </p>
              <h1
                id="connection-return-title"
                className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
              >
                You’re back in Backoffice.
              </h1>
              <p className="mt-4 text-sm leading-6 text-pretty text-[var(--bo-muted)]">
                Your browser has returned from provider authorization. This page does not confirm
                whether your account is connected.
              </p>
              <dl className="mt-6 divide-y divide-[color:var(--bo-border)] border-y border-[color:var(--bo-border)] text-sm">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
                  <dt className="text-[var(--bo-muted)]">Browser return</dt>
                  <dd className="font-medium">Received</dd>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
                  <dt className="text-[var(--bo-muted)]">Account connection</dt>
                  <dd className="font-medium text-[var(--bo-waiting)]">
                    Check in your original tab
                  </dd>
                </div>
              </dl>
            </div>
            <div className="border-t border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-6 sm:p-8">
              <h2 className="text-base font-semibold">Finish in your original tab</h2>
              <p className="mt-2 text-sm leading-6 text-pretty text-[var(--bo-muted)]">
                Return to the terminal or agent that started this connection and check the saved
                request. Only a verified connected result confirms that the account is ready to use.
                You can close this tab after returning to that flow.
              </p>
              <details className="mt-4 text-sm">
                <summary className="min-h-11 cursor-pointer py-3 text-[var(--bo-fg)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[color:var(--bo-accent)]">
                  Using the Backoffice terminal?
                </summary>
                <p className="mt-2 leading-6 text-[var(--bo-muted)]">
                  Use the request ID from your original connect command:
                </p>
                <pre className="mt-3 overflow-x-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-xs leading-6">
                  <code>connector.connections.refresh --request-id REQUEST_ID --format json</code>
                </pre>
              </details>
              <p className="mt-4 text-sm leading-6 text-pretty text-[var(--bo-muted)]">
                Cancelled consent or saw a provider error? Return to the original flow and start a
                new connection request if needed.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
                <Link
                  to={backUrl}
                  className="inline-flex min-h-11 items-center justify-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-sm font-semibold text-[var(--bo-accent-fg)] transition-colors hover:bg-[var(--bo-panel)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[color:var(--bo-accent)]"
                >
                  Return to Backoffice
                </Link>
                <span className="min-w-0 text-xs text-pretty break-words text-[var(--bo-muted-2)]">
                  {scopeLabel}
                </span>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
