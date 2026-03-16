import { useEffect, useState } from "react";
import { Link, Outlet, useLoaderData, useLocation } from "react-router";

import {
  getCloudflareWorkersDurableObject,
  getAutomationsDurableObject,
  getGitHubDurableObject,
  getOtpDurableObject,
  getPiDurableObject,
  getResendDurableObject,
  getTelegramDurableObject,
  getUploadDurableObject,
} from "@/cloudflare/cloudflare-utils";
import { BackofficePageHeader } from "@/components/backoffice";
import { getAuthMe } from "@/fragno/auth-server";
import type { DurableHookQueueEntry, DurableHookQueueResponse } from "@/fragno/durable-hooks";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/durable-hooks-organisation";
import {
  DURABLE_HOOK_ORG_FRAGMENTS,
  FRAGMENT_CONFIGURE_META,
  FRAGMENT_LABELS,
  getDurableHooksLoaderErrorMessage,
  isDurableHookOrgFragment,
  type DurableHooksOrgFragment,
} from "./durable-hooks-organisation-state";
import { formatTimestamp, getStatusBadgeClasses } from "./durable-hooks-shared";

export type DurableHooksOrgOutletContext = {
  hooks: DurableHookQueueEntry[];
  selectedHookId: string | null;
  onSelectHook: (hookId: string | null) => void;
};

type DurableHooksOrgLoaderData = DurableHookQueueResponse & {
  error: string | null;
  orgId: string;
  organisationName: string | null;
  fragment: DurableHooksOrgFragment;
};

const parsePageSize = (value: string | null) => {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const resolveFragment = (value?: string | null): DurableHooksOrgFragment | null => {
  if (value === "workflows") {
    return "automations";
  }
  if (value && isDurableHookOrgFragment(value)) {
    return value as DurableHooksOrgFragment;
  }
  return null;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    const url = new URL(request.url);
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

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const pageSize = parsePageSize(url.searchParams.get("pageSize"));
  const fragment = resolveFragment(params.fragment);

  if (!fragment) {
    throw new Response("Not Found", { status: 404 });
  }

  try {
    const queueData = await (async (): Promise<DurableHookQueueResponse> => {
      switch (fragment) {
        case "cloudflare":
          return (await getCloudflareWorkersDurableObject(context, params.orgId).getHookQueue({
            orgId: params.orgId,
            cursor,
            pageSize,
          })) as DurableHookQueueResponse;
        case "telegram":
          return (await getTelegramDurableObject(context, params.orgId).getHookQueue({
            cursor,
            pageSize,
          })) as DurableHookQueueResponse;
        case "otp":
          return (await getOtpDurableObject(context, params.orgId).getHookQueue({
            cursor,
            pageSize,
          })) as DurableHookQueueResponse;
        case "resend":
          return (await getResendDurableObject(context, params.orgId).getHookQueue({
            cursor,
            pageSize,
          })) as DurableHookQueueResponse;
        case "github":
          return (await getGitHubDurableObject(context, params.orgId).getHookQueue({
            cursor,
            pageSize,
          })) as DurableHookQueueResponse;
        case "upload":
          return (await getUploadDurableObject(context, params.orgId).getHookQueue({
            cursor,
            pageSize,
          })) as DurableHookQueueResponse;
        case "automations":
          return (await getAutomationsDurableObject(context, params.orgId).getHookQueue({
            cursor,
            pageSize,
          })) as DurableHookQueueResponse;
        case "pi":
          return (await getPiDurableObject(context, params.orgId).getHookQueue({
            cursor,
            pageSize,
            fragment,
          })) as DurableHookQueueResponse;
      }
    })();

    return {
      configured: queueData.configured,
      hooksEnabled: queueData.hooksEnabled,
      namespace: queueData.namespace,
      items: queueData.items,
      cursor: queueData.cursor,
      hasNextPage: queueData.hasNextPage,
      error: null,
      orgId: params.orgId,
      organisationName: organisation.name ?? null,
      fragment,
    } satisfies DurableHooksOrgLoaderData;
  } catch (error) {
    return {
      configured: false,
      hooksEnabled: false,
      namespace: null,
      items: [],
      cursor: undefined,
      hasNextPage: false,
      error: getDurableHooksLoaderErrorMessage({
        fragment,
        orgId: params.orgId,
        error,
      }),
      orgId: params.orgId,
      organisationName: organisation.name ?? null,
      fragment,
    } satisfies DurableHooksOrgLoaderData;
  }
}

export function meta({ data }: Route.MetaArgs) {
  const orgLabel = data?.organisationName ?? data?.orgId ?? "organisation";
  return [{ title: `Durable Hooks · ${orgLabel}` }];
}

export default function BackofficeDurableHooksOrganisation() {
  const {
    items,
    configured,
    hooksEnabled,
    namespace,
    error,
    orgId,
    organisationName,
    cursor,
    hasNextPage,
    fragment,
  } = useLoaderData<typeof loader>();
  const location = useLocation();
  const [selectedHookId, setSelectedHookId] = useState<string | null>(null);
  const baseScopePath = `/backoffice/internals/durable-hooks/${orgId}`;
  const fragmentBasePath = `${baseScopePath}/${fragment}`;
  const searchParams = new URLSearchParams(location.search);
  const currentCursor = searchParams.get("cursor");
  const isDetailRoute = Boolean(selectedHookId);

  const listVisibility = isDetailRoute ? "hidden lg:block" : "block";
  const detailVisibility = isDetailRoute ? "block" : "hidden lg:block";

  const activeFragment = fragment;
  const fragmentLabel = FRAGMENT_LABELS[activeFragment];
  const configureMeta = FRAGMENT_CONFIGURE_META[activeFragment];
  const configurePath = configureMeta.path(orgId);
  const queueCount = items.length;
  const nextCursor = cursor;
  const nextSearchParams = new URLSearchParams(searchParams);
  if (nextCursor) {
    nextSearchParams.set("cursor", nextCursor);
  }
  const nextSearch = nextSearchParams.toString();
  const nextPageHref = nextCursor ? `${fragmentBasePath}?${nextSearch}` : null;
  const newestSearchParams = new URLSearchParams(searchParams);
  newestSearchParams.delete("cursor");
  const newestSearch = newestSearchParams.toString();
  const newestPageHref = newestSearch ? `${fragmentBasePath}?${newestSearch}` : fragmentBasePath;
  const fragmentTabHref = (fragmentId: DurableHooksOrgFragment) => {
    const params = new URLSearchParams(searchParams);
    params.delete("cursor");
    const query = params.toString();
    const tabBasePath = `${baseScopePath}/${fragmentId}`;
    return query ? `${tabBasePath}?${query}` : tabBasePath;
  };
  const fragmentTabs = DURABLE_HOOK_ORG_FRAGMENTS.map((fragmentId) => ({
    id: fragmentId,
    label: FRAGMENT_LABELS[fragmentId],
    to: fragmentTabHref(fragmentId),
    disabled: false,
  }));

  useEffect(() => {
    setSelectedHookId(null);
  }, [fragment, orgId]);

  useEffect(() => {
    if (!selectedHookId) {
      return;
    }
    const stillVisible = items.some((item) => item.id === selectedHookId);
    if (!stillVisible) {
      setSelectedHookId(null);
    }
  }, [items, selectedHookId]);

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Internals", to: "/backoffice/internals" },
          { label: "Durable hooks", to: "/backoffice/internals/durable-hooks" },
          { label: organisationName ?? orgId },
        ]}
        eyebrow="Internals"
        title={`Durable hook queue · ${organisationName ?? orgId}`}
        description="Review queued hooks for fragment services scoped to this organisation."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/backoffice/internals/durable-hooks"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              Back to scopes
            </Link>
            <Link
              to="/backoffice/internals/durable-hooks/singletons"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              View singleton hooks
            </Link>
          </div>
        }
      />

      <div
        role="tablist"
        aria-label="Durable hook fragments"
        className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
      >
        {fragmentTabs.map((tab) => {
          const isActive = activeFragment === tab.id;
          const className = isActive
            ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)]"
            : tab.disabled
              ? "cursor-not-allowed border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted-2)] opacity-60"
              : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]";

          if (tab.disabled) {
            return (
              <span
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                aria-disabled="true"
                className={className}
              >
                {tab.label}
              </span>
            );
          }

          return (
            <Link
              key={tab.id}
              to={tab.to}
              role="tab"
              aria-selected={isActive}
              className={className}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      <section className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div
          className={`${listVisibility} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                Queue
              </p>
              <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                {fragmentLabel} durable hooks
              </h2>
              <p className="mt-1 text-xs text-[var(--bo-muted-2)]">
                Namespace: {namespace ?? "Unavailable"}
              </p>
            </div>
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
              {queueCount} shown
            </span>
          </div>

          <div className="mt-4 space-y-3">
            {error ? (
              <div className="border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                {error}
              </div>
            ) : !configured ? (
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                {fragmentLabel} is not configured for this organisation yet.
                <Link
                  to={configurePath}
                  className="ml-2 inline-flex text-[var(--bo-accent)] hover:text-[var(--bo-accent-strong)]"
                >
                  {configureMeta.label}
                </Link>
              </div>
            ) : !hooksEnabled ? (
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                Durable hooks are disabled for this fragment. Enable durable hooks to begin queueing
                work.
              </div>
            ) : queueCount === 0 ? (
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                No durable hooks are queued right now.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="backoffice-scroll overflow-x-auto border border-[color:var(--bo-border)]">
                  <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
                    <thead className="bg-[var(--bo-panel-2)] text-left">
                      <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                        <th scope="col" className="px-3 py-2">
                          Hook
                        </th>
                        <th scope="col" className="px-3 py-2">
                          Status
                        </th>
                        <th scope="col" className="px-3 py-2">
                          Attempts
                        </th>
                        <th scope="col" className="px-3 py-2">
                          Last attempt
                        </th>
                        <th scope="col" className="px-3 py-2">
                          Next retry
                        </th>
                        <th scope="col" className="px-3 py-2">
                          Created
                        </th>
                        <th scope="col" className="px-3 py-2 text-right">
                          Detail
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                      {items.map((hook) => {
                        const isSelected = hook.id === selectedHookId;
                        return (
                          <tr
                            key={hook.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`View durable hook ${hook.hookName}`}
                            onClick={() => setSelectedHookId(hook.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setSelectedHookId(hook.id);
                              }
                            }}
                            className={
                              isSelected
                                ? "cursor-pointer bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--bo-accent)]"
                                : "cursor-pointer text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--bo-accent)]"
                            }
                          >
                            <td className="px-3 py-2">
                              <div>
                                <span
                                  className={
                                    isSelected
                                      ? "font-semibold text-[var(--bo-accent-fg)]"
                                      : "font-semibold text-[var(--bo-fg)]"
                                  }
                                >
                                  {hook.hookName}
                                </span>
                                <p
                                  className={
                                    isSelected
                                      ? "text-xs text-[var(--bo-accent-fg)]/80"
                                      : "text-xs text-[var(--bo-muted-2)]"
                                  }
                                >
                                  ID: {hook.id}
                                </p>
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={`border px-2 py-1 text-[10px] tracking-[0.22em] uppercase ${getStatusBadgeClasses(hook.status)}`}
                              >
                                {hook.status}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              {hook.attempts} / {hook.maxAttempts}
                            </td>
                            <td className="px-3 py-2">
                              {formatTimestamp(hook.lastAttemptAt) || "-"}
                            </td>
                            <td className="px-3 py-2">
                              {formatTimestamp(hook.nextRetryAt) || "-"}
                            </td>
                            <td className="px-3 py-2">{formatTimestamp(hook.createdAt) || "-"}</td>
                            <td className="px-3 py-2 text-right">
                              <span
                                className={
                                  isSelected
                                    ? "text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase"
                                    : "text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase hover:text-[var(--bo-fg)]"
                                }
                              >
                                View
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--bo-muted-2)]">
                  <span>
                    {queueCount} hook{queueCount === 1 ? "" : "s"} shown
                  </span>
                  <div className="flex items-center gap-2">
                    {currentCursor ? (
                      <Link
                        to={newestPageHref}
                        className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                      >
                        Newest
                      </Link>
                    ) : null}
                    {hasNextPage && nextPageHref ? (
                      <Link
                        to={nextPageHref}
                        className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                      >
                        Next page
                      </Link>
                    ) : null}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div
          className={`${detailVisibility} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
        >
          <Outlet
            context={{
              hooks: items,
              selectedHookId,
              onSelectHook: setSelectedHookId,
            }}
          />
        </div>
      </section>
    </div>
  );
}
