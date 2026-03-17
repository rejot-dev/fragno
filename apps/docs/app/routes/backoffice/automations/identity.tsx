import { Form, useActionData, useNavigation, useOutletContext } from "react-router";

import type { Route } from "./+types/identity";
import { revokeAutomationIdentityBinding } from "./data";
import type { AutomationLayoutContext } from "./shared";
import { AutomationBadge, formatAutomationSource, formatTimestamp } from "./shared";

type IdentityActionData = {
  ok: boolean;
  message: string;
  bindingId?: string;
};

export async function action({ request, params, context }: Route.ActionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "").trim();
  const bindingId = String(formData.get("bindingId") ?? "").trim();

  if (intent !== "revoke-identity") {
    return {
      ok: false,
      message: "Unknown identity action.",
    } satisfies IdentityActionData;
  }

  if (!bindingId) {
    return {
      ok: false,
      message: "Identity binding is required.",
    } satisfies IdentityActionData;
  }

  const result = await revokeAutomationIdentityBinding(request, context, params.orgId, bindingId);

  if (!result.ok) {
    return {
      ok: false,
      message: result.error ?? "Unable to revoke identity binding.",
      bindingId,
    } satisfies IdentityActionData;
  }

  return {
    ok: true,
    message: "Identity binding revoked.",
    bindingId,
  } satisfies IdentityActionData;
}

export default function BackofficeOrganisationAutomationIdentity() {
  const { identityBindings, identityBindingsError } = useOutletContext<AutomationLayoutContext>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const pendingBindingId =
    navigation.state === "submitting" ? String(navigation.formData?.get("bindingId") ?? "") : "";

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

      {identityBindingsError ? (
        <div className="border border-red-400/40 bg-red-500/8 p-4 text-sm text-red-700 dark:text-red-200">
          Could not load identity bindings from the automation schema: {identityBindingsError}
        </div>
      ) : identityBindings.length === 0 ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
          No identity bindings have been recorded yet.
        </div>
      ) : (
        <div className="backoffice-scroll overflow-x-auto border border-[color:var(--bo-border)]">
          <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
            <thead className="bg-[var(--bo-panel-2)] text-left">
              <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                <th scope="col" className="px-3 py-2">
                  Source
                </th>
                <th scope="col" className="px-3 py-2">
                  External actor
                </th>
                <th scope="col" className="px-3 py-2">
                  User
                </th>
                <th scope="col" className="px-3 py-2">
                  Status
                </th>
                <th scope="col" className="px-3 py-2">
                  Linked
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
              {identityBindings.map((binding) => {
                const isRevoked = binding.status === "revoked";
                const isSubmitting = pendingBindingId === binding.id;

                return (
                  <tr key={binding.id} className="text-[var(--bo-muted)]">
                    <td className="px-3 py-3 align-top">
                      <div>
                        <p className="font-semibold text-[var(--bo-fg)]">
                          {formatAutomationSource(binding.source)}
                        </p>
                        <p className="mt-1 font-mono text-xs text-[var(--bo-muted-2)]">
                          {binding.source}
                        </p>
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="font-mono text-xs text-[var(--bo-fg)]">
                        {binding.externalActorId}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="font-mono text-xs text-[var(--bo-fg)]">
                        {binding.userId}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <AutomationBadge tone={binding.status === "linked" ? "success" : "neutral"}>
                        {binding.status}
                      </AutomationBadge>
                    </td>
                    <td className="px-3 py-3 align-top">{formatTimestamp(binding.linkedAt)}</td>
                    <td className="px-3 py-3 align-top">{formatTimestamp(binding.updatedAt)}</td>
                    <td className="px-3 py-3 text-right align-top">
                      {isRevoked ? (
                        <span className="text-xs text-[var(--bo-muted-2)]">Revoked</span>
                      ) : (
                        <Form method="post" className="inline-flex">
                          <input type="hidden" name="intent" value="revoke-identity" />
                          <input type="hidden" name="bindingId" value={binding.id} />
                          <button
                            type="submit"
                            disabled={isSubmitting}
                            className="border border-red-400/40 bg-red-500/8 px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-red-700 uppercase transition-colors hover:border-red-400/60 hover:bg-red-500/12 disabled:cursor-not-allowed disabled:opacity-60 dark:text-red-200"
                          >
                            {isSubmitting ? "Revoking…" : "Revoke"}
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
