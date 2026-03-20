import { Link, useOutletContext } from "react-router";

import { AUTOMATION_TRIGGER_ORDER_LAST } from "@/fragno/automation/schema";

import type { AutomationLayoutContext } from "./shared";
import { AutomationBadge, formatAutomationSource } from "./shared";

export default function BackofficeOrganisationAutomationTriggers() {
  const { orgId, triggerBindings, triggerBindingsError } =
    useOutletContext<AutomationLayoutContext>();

  if (triggerBindingsError) {
    return (
      <div className="border border-red-400/40 bg-red-500/8 p-4 text-sm text-red-700 dark:text-red-200">
        Could not load automation bindings from /workspace/automations: {triggerBindingsError}
      </div>
    );
  }

  if (triggerBindings.length === 0) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        No automation bindings are configured in this organisation&apos;s workspace yet.
      </div>
    );
  }

  return (
    <div className="backoffice-scroll overflow-x-auto border border-[color:var(--bo-border)]">
      <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
        <thead className="bg-[var(--bo-panel-2)] text-left">
          <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            <th scope="col" className="px-3 py-2">
              Source
            </th>
            <th scope="col" className="px-3 py-2">
              Event type
            </th>
            <th scope="col" className="px-3 py-2">
              Order
            </th>
            <th scope="col" className="px-3 py-2">
              Script
            </th>
            <th scope="col" className="px-3 py-2">
              Location
            </th>
            <th scope="col" className="px-3 py-2">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
          {triggerBindings.map((binding) => (
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
                <code className="font-mono text-xs text-[var(--bo-fg)]">{binding.eventType}</code>
              </td>
              <td className="px-3 py-3 align-top">
                <span className="font-mono text-xs text-[var(--bo-fg)]">
                  {binding.triggerOrder != null &&
                  Number.isFinite(binding.triggerOrder) &&
                  binding.triggerOrder !== AUTOMATION_TRIGGER_ORDER_LAST
                    ? String(binding.triggerOrder)
                    : "—"}
                </span>
              </td>
              <td className="px-3 py-3 align-top">
                <div className="space-y-1">
                  <Link
                    to={`/backoffice/automations/${orgId}/scripts?script=${encodeURIComponent(binding.scriptId)}`}
                    className="text-sm font-semibold text-[var(--bo-fg)] underline decoration-[color:var(--bo-border-strong)] underline-offset-4 transition-colors hover:text-[var(--bo-accent-fg)]"
                  >
                    {binding.scriptName}
                  </Link>
                  <p className="font-mono text-xs text-[var(--bo-muted-2)]">
                    {binding.scriptKey} · v{binding.scriptVersion}
                  </p>
                </div>
              </td>
              <td className="px-3 py-3 align-top">
                <div className="space-y-2">
                  <AutomationBadge tone="accent">Workspace</AutomationBadge>
                  <p className="font-mono text-xs text-[var(--bo-muted-2)]">{binding.scriptPath}</p>
                </div>
              </td>
              <td className="px-3 py-3 align-top">
                <AutomationBadge tone={binding.enabled ? "success" : "neutral"}>
                  {binding.enabled ? "Enabled" : "Disabled"}
                </AutomationBadge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
