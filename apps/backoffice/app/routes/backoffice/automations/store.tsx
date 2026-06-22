import { Form, useActionData, useNavigation, useOutletContext } from "react-router";

import type { Route } from "./+types/store";
import { deleteAutomationStoreEntry } from "./data";
import { useLofiAutomationStoreEntries } from "./lofi-store";
import type { AutomationLayoutContext } from "./shared";
import { formatTimestamp } from "./shared";

type StoreActionData = {
  ok: boolean;
  message: string;
  key?: string;
};

export async function action({ request, params, context }: Route.ActionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

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

  const result = await deleteAutomationStoreEntry(request, context, params.orgId, key);

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

const formatActor = (actor: AutomationLayoutContext["storeEntries"][number]["actor"]) => {
  if (!actor) {
    return "—";
  }

  const source = actor.source ? `${actor.source}/` : "";
  return `${actor.scope}:${source}${actor.type}:${actor.id}`;
};

export default function BackofficeOrganisationAutomationStore() {
  const { orgId, storeEntries, storeEntriesError, storePrefix } =
    useOutletContext<AutomationLayoutContext>();
  const lofiStore = useLofiAutomationStoreEntries({
    orgId,
    initialEntries: storeEntries,
    prefix: storePrefix,
  });
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const pendingKey =
    navigation.state === "submitting" ? String(navigation.formData?.get("key") ?? "") : "";

  return (
    <div className="space-y-4">
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

      <Form
        method="get"
        className="flex flex-wrap items-end gap-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
      >
        <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-[var(--bo-muted)]">
          <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Key prefix
          </span>
          <input
            name="prefix"
            defaultValue={storePrefix}
            placeholder="telegram/"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-xs text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
          />
        </label>
        <button
          type="submit"
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Scan prefix
        </button>
      </Form>

      {storeEntriesError || lofiStore.error ? (
        <div className="border border-red-400/40 bg-red-500/8 p-4 text-sm text-red-700 dark:text-red-200">
          {storeEntriesError
            ? `Could not load store entries from the automations service: ${storeEntriesError}`
            : `Could not sync local automation store updates: ${lofiStore.error}`}
        </div>
      ) : (
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
              {lofiStore.entries.map((entry) => {
                const isSubmitting = pendingKey === entry.key;
                const isSystemEntry = entry.category.includes("system");

                return (
                  <tr key={entry.id} className="text-[var(--bo-muted)]">
                    <td className="px-3 py-3 align-top">
                      <span className="font-mono text-xs text-[var(--bo-fg)]">{entry.key}</span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="font-mono text-xs text-[var(--bo-fg)]">{entry.value}</span>
                    </td>
                    <td className="max-w-xs px-3 py-3 align-top text-xs">
                      {entry.description || "—"}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex flex-wrap gap-1">
                        {entry.category.length
                          ? entry.category.map((category) => (
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
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  throw error;
}
