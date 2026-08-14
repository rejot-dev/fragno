import { useState } from "react";
import { useOutletContext, useSearchParams } from "react-router";

import { useLiveQuery } from "@tanstack/react-db";

import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/identity-bindings";
import { formatTimestamp } from "./formatting";
import type { AutomationLayoutContext } from "./layout-context";
import { automationScopeFromRouteParams } from "./scope";

type BindingStatus = "all" | "active" | "revoked";

type BindingCursor = {
  id: string;
  source: string;
  externalType: string;
  externalId: string;
};

const BINDINGS_PAGE_SIZE = 25;

const bindingStatusFromSearchParam = (value: string | null): BindingStatus =>
  value === "active" || value === "revoked" ? value : "all";

const searchableBindingText = (binding: {
  id: string;
  source: string;
  externalType: string;
  externalId: string;
  userId: string;
  verifiedByClaimId: string;
}) =>
  [
    binding.id,
    binding.source,
    binding.externalType,
    binding.externalId,
    binding.userId,
    binding.verifiedByClaimId,
  ]
    .join("\n")
    .toLowerCase();

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = automationScopeFromRouteParams(params);
  const execution = await requireBackofficeContext(request, context, scope);
  const { kernel } = context.get(BackofficeWorkerContext);

  try {
    await kernel.assertAuthorized({
      execution,
      operation: BACKOFFICE_PERMISSION.identity.read,
      resource: { kind: "external-identity-bindings" },
    });
  } catch (error) {
    if (error instanceof BackofficeForbiddenError) {
      throw new Response(error.message, { status: 403 });
    }
    throw error;
  }

  return null;
}

export function meta() {
  return [
    { title: "Automation identity bindings" },
    {
      name: "description",
      content: "Inspect external identities bound to users in the selected automation scope.",
    },
  ];
}

export default function BackofficeAutomationIdentityBindings() {
  const { collections } = useOutletContext<AutomationLayoutContext>();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get("search")?.trim() ?? "");
  const [status, setStatus] = useState<BindingStatus>(() =>
    bindingStatusFromSearchParam(searchParams.get("status")),
  );
  const [pageCursors, setPageCursors] = useState<BindingCursor[]>([]);
  const pageCursor = pageCursors.at(-1);
  const page = pageCursors.length + 1;
  const normalizedSearch = search.trim().toLowerCase();
  const bindingsQuery = useLiveQuery(
    (query) =>
      query
        .from({ binding: collections.externalIdentityBindings })
        .fn.where(({ binding }) => {
          const bindingStatus = binding.revokedAt ? "revoked" : "active";
          const matchesFilters =
            (status === "all" || status === bindingStatus) &&
            (!normalizedSearch || searchableBindingText(binding).includes(normalizedSearch));
          const followsCursor =
            !pageCursor ||
            binding.source > pageCursor.source ||
            (binding.source === pageCursor.source &&
              (binding.externalType > pageCursor.externalType ||
                (binding.externalType === pageCursor.externalType &&
                  (binding.externalId > pageCursor.externalId ||
                    (binding.externalId === pageCursor.externalId &&
                      binding.id > pageCursor.id)))));

          return matchesFilters && followsCursor;
        })
        .orderBy(({ binding }) => binding.source, "asc")
        .orderBy(({ binding }) => binding.externalType, "asc")
        .orderBy(({ binding }) => binding.externalId, "asc")
        .orderBy(({ binding }) => binding.id, "asc")
        .limit(BINDINGS_PAGE_SIZE + 1)
        .select(({ binding }) => ({
          id: binding.id,
          source: binding.source,
          externalType: binding.externalType,
          externalId: binding.externalId,
          userId: binding.userId,
          verifiedByClaimId: binding.verifiedByClaimId,
          boundAt: binding.boundAt,
          revokedAt: binding.revokedAt,
        })),
    [collections.externalIdentityBindings, normalizedSearch, pageCursor, status],
  );
  const pageRows = bindingsQuery.data ?? [];
  const hasNextPage = pageRows.length > BINDINGS_PAGE_SIZE;
  const nextPageBoundary = hasNextPage ? pageRows[BINDINGS_PAGE_SIZE - 1] : undefined;
  const nextPageCursor = nextPageBoundary
    ? {
        id: nextPageBoundary.id,
        source: nextPageBoundary.source,
        externalType: nextPageBoundary.externalType,
        externalId: nextPageBoundary.externalId,
      }
    : null;
  const bindings = pageRows.slice(0, BINDINGS_PAGE_SIZE);
  const hasFilters = Boolean(normalizedSearch) || status !== "all";
  const bindingsError = bindingsQuery.isError
    ? "External identity binding synchronization failed."
    : null;

  return (
    <section className="flex w-full max-w-7xl flex-1 flex-col space-y-4">
      {bindingsError ? (
        <div className="border border-amber-400/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-200">
          Could not synchronize all external identity bindings: {bindingsError}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
        <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-[var(--bo-muted)]">
          <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Search bindings
          </span>
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
              setPageCursors([]);
            }}
            placeholder="source, identity, user, claim…"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--bo-muted)]">
          <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Status
          </span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.currentTarget.value as BindingStatus);
              setPageCursors([]);
            }}
            className="min-w-36 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="revoked">Revoked</option>
          </select>
        </label>
      </div>

      {bindingsQuery.isLoading && bindings.length === 0 ? (
        <BindingState>Loading external identity bindings…</BindingState>
      ) : bindingsError && bindings.length === 0 ? (
        <BindingState>External identity bindings are unavailable.</BindingState>
      ) : bindings.length === 0 ? (
        <BindingState>
          {pageCursors.length > 0
            ? "No external identity bindings remain on this page."
            : hasFilters
              ? "No bindings match the current search and status filters."
              : "No external identities have been bound in this scope yet."}
        </BindingState>
      ) : (
        <>
          <div className="backoffice-scroll flex-1 overflow-x-auto border border-[color:var(--bo-border)]">
            <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
              <thead className="bg-[var(--bo-panel-2)] text-left">
                <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  <th scope="col" className="px-3 py-2">
                    External identity
                  </th>
                  <th scope="col" className="px-3 py-2">
                    User
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Verified claim
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Bound
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Revoked
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                {bindings.map((binding) => {
                  const isRevoked = Boolean(binding.revokedAt);

                  return (
                    <tr key={binding.id} className="text-[var(--bo-muted)]">
                      <td className="max-w-md px-3 py-3 align-top">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] px-2 py-1 font-mono text-[10px] text-[var(--bo-fg)]">
                            {binding.source}
                          </span>
                          <span className="font-mono text-xs text-[var(--bo-fg)]">
                            {binding.externalType}:{binding.externalId}
                          </span>
                        </div>
                      </td>
                      <td className="max-w-xs px-3 py-3 align-top">
                        <span className="font-mono text-xs break-all text-[var(--bo-fg)]">
                          {binding.userId}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <span
                          className={
                            isRevoked
                              ? "inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase"
                              : "inline-flex border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold tracking-[0.18em] text-emerald-700 uppercase dark:text-emerald-200"
                          }
                        >
                          {isRevoked ? "Revoked" : "Active"}
                        </span>
                      </td>
                      <td className="max-w-xs px-3 py-3 align-top">
                        <span className="font-mono text-xs break-all text-[var(--bo-fg)]">
                          {binding.verifiedByClaimId}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-top whitespace-nowrap">
                        {formatTimestamp(binding.boundAt)}
                      </td>
                      <td className="px-3 py-3 align-top whitespace-nowrap">
                        {formatTimestamp(binding.revokedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {bindings.length > 0 || pageCursors.length > 0 ? (
        <div className="flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 text-xs text-[var(--bo-muted-2)]">
          <span>
            {bindings.length} binding{bindings.length === 1 ? "" : "s"} shown · Page {page}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pageCursors.length === 0}
              onClick={() => {
                setPageCursors((current) => current.slice(0, -1));
              }}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[9px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!nextPageCursor}
              onClick={() => {
                if (nextPageCursor) {
                  setPageCursors((current) => [...current, nextPageCursor]);
                }
              }}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[9px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BindingState({ children }: { children: string }) {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
      {children}
    </div>
  );
}
