import { Suspense, use, useState } from "react";
import {
  Form,
  useActionData,
  useNavigation,
  useOutletContext,
  useSearchParams,
} from "react-router";

import { useLiveQuery } from "@tanstack/react-db";

import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { ClientOnly } from "@/components/client-only";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";

import type { Route } from "./+types/store";
import { deleteAutomationStoreEntry } from "./data.server";
import { automationScopeFromRouteParams, automationScopeRouteId, toBackofficeScope } from "./scope";
import type { AutomationLayoutContext, AutomationStoreItem } from "./shared";
import { formatTimestamp } from "./shared";
import { getAutomationTanStackDatabase } from "./tanstack/database";

type StoreActionData = {
  ok: boolean;
  message: string;
  key?: string;
};

export async function action({ request, params, context }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "").trim();
  const key = String(formData.get("key") ?? "").trim();

  if (intent !== "delete-store-entry") {
    return {
      ok: false,
      message: "Unknown store action.",
    } satisfies StoreActionData;
  }

  if (!key) {
    return {
      ok: false,
      message: "Store entry key is required.",
    } satisfies StoreActionData;
  }

  const scope = automationScopeFromRouteParams(params);
  await requireBackofficeContext(request, context, scope);

  const result = await deleteAutomationStoreEntry(request, context, scope, key);

  if (!result.ok) {
    return {
      ok: false,
      message: result.error ?? "Unable to delete store entry.",
      key,
    } satisfies StoreActionData;
  }

  return {
    ok: true,
    message: "Store entry deleted.",
    key,
  } satisfies StoreActionData;
}

const formatActor = (actor: AutomationStoreItem["actor"]) => {
  if (!actor) {
    return "—";
  }

  const source = actor.source ? `${actor.source}/` : "";
  return `${actor.scope}:${source}${actor.type}:${actor.id}`;
};

export default function BackofficeOrganisationAutomationStore() {
  const { selectedScope, adapterIdentity } = useOutletContext<AutomationLayoutContext>();
  const [searchParams] = useSearchParams();
  const [storePrefix, setStorePrefix] = useState(() => searchParams.get("prefix") ?? "");
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const pendingKey =
    navigation.state === "submitting" ? String(navigation.formData?.get("key") ?? "") : "";

  return (
    <div className="w-full max-w-7xl space-y-4">
      {actionData?.message ? (
        <div
          className={
            actionData.ok
              ? "border border-emerald-400/40 bg-emerald-500/12 p-4 text-sm text-emerald-700 dark:text-emerald-200"
              : "border border-red-400/40 bg-red-500/8 p-4 text-sm text-red-700 dark:text-red-200"
          }
        >
          {actionData.message}
        </div>
      ) : null}

      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
        <label className="flex flex-col gap-1 text-xs text-[var(--bo-muted)]">
          <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Key prefix
          </span>
          <input
            value={storePrefix}
            onChange={(event) => {
              setStorePrefix(event.currentTarget.value);
            }}
            placeholder="telegram/"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-xs text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
          />
        </label>
      </div>

      <ClientOnly fallback={<AutomationStoreLoading />}>
        <Suspense fallback={<AutomationStoreLoading />}>
          <AutomationKvStoreTable
            scope={selectedScope}
            adapterIdentity={adapterIdentity}
            prefix={storePrefix}
            pendingKey={pendingKey}
          />
        </Suspense>
      </ClientOnly>
    </div>
  );
}

function AutomationStoreLoading() {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
      Loading the local automation store…
      <noscript>
        <span className="mt-2 block text-red-700 dark:text-red-200">
          JavaScript is required to open the local automation store.
        </span>
      </noscript>
    </div>
  );
}

function AutomationKvStoreTable({
  scope,
  adapterIdentity,
  prefix,
  pendingKey,
}: {
  scope: AutomationLayoutContext["selectedScope"];
  adapterIdentity: string;
  prefix: string;
  pendingKey: string;
}) {
  const database = use(getAutomationTanStackDatabase());
  const scopeKey = backofficeContextScopeSinglePathSegment(toBackofficeScope(scope));
  const routeId = automationScopeRouteId(scope);
  const internalUrl = `/api/automations-scoped/${scope.kind}/${encodeURIComponent(routeId)}/_internal`;
  const collections = database.collectionsFor({ scopeKey, internalUrl, adapterIdentity });
  const store = useLiveQuery(
    (builder) => {
      const query = builder.from({ entry: collections.kvStore });
      return (prefix ? query.fn.where(({ entry }) => entry.key.startsWith(prefix)) : query).orderBy(
        ({ entry }) => entry.key,
        "asc",
      );
    },
    [collections.kvStore, prefix],
  );
  const entries = store.data ?? [];

  if (store.isLoading && entries.length === 0) {
    return <AutomationStoreLoading />;
  }

  return (
    <div className="backoffice-scroll overflow-x-auto border border-[color:var(--bo-border)]">
      <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
        <thead className="bg-[var(--bo-panel-2)] text-left">
          <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            <th scope="col" className="px-3 py-2">
              Key
            </th>
            <th scope="col" className="px-3 py-2">
              Value
            </th>
            <th scope="col" className="px-3 py-2">
              Description
            </th>
            <th scope="col" className="px-3 py-2">
              Category
            </th>
            <th scope="col" className="px-3 py-2">
              Actor
            </th>
            <th scope="col" className="px-3 py-2">
              Created
            </th>
            <th scope="col" className="px-3 py-2">
              Updated
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
          {entries.map((entry) => {
            const categories = entry.category ?? [];
            const isSubmitting = pendingKey === entry.key;
            const isSystemEntry = categories.includes("system");

            return (
              <tr key={entry.id} className="text-[var(--bo-muted)]">
                <td className="px-3 py-3 align-top">
                  <span className="font-mono text-xs text-[var(--bo-fg)]">{entry.key}</span>
                </td>
                <td className="px-3 py-3 align-top">
                  <span className="font-mono text-xs text-[var(--bo-fg)]">{entry.value}</span>
                </td>
                <td className="max-w-xs px-3 py-3 align-top text-xs">{entry.description || "—"}</td>
                <td className="px-3 py-3 align-top">
                  <div className="flex flex-wrap gap-1">
                    {categories.length
                      ? categories.map((category) => (
                          <span
                            key={category}
                            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 font-mono text-[10px] text-[var(--bo-muted)]"
                          >
                            {category}
                          </span>
                        ))
                      : "—"}
                  </div>
                </td>
                <td className="px-3 py-3 align-top">
                  <span className="font-mono text-xs text-[var(--bo-fg)]">
                    {formatActor(entry.actor)}
                  </span>
                </td>
                <td className="px-3 py-3 align-top">{formatTimestamp(entry.createdAt)}</td>
                <td className="px-3 py-3 align-top">{formatTimestamp(entry.updatedAt)}</td>
                <td className="px-3 py-3 text-right align-top">
                  {isSystemEntry ? null : (
                    <Form method="post" className="inline-flex">
                      <input type="hidden" name="intent" value="delete-store-entry" />
                      <input type="hidden" name="key" value={entry.key} />
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="border border-red-400/40 bg-red-500/8 px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-red-700 uppercase transition-colors hover:border-red-400/60 hover:bg-red-500/12 disabled:cursor-not-allowed disabled:opacity-60 dark:text-red-200"
                      >
                        {isSubmitting ? "Deleting…" : "Delete"}
                      </button>
                    </Form>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  throw error;
}
