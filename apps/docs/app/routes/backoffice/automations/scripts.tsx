import { Link, useOutletContext, useSearchParams } from "react-router";

import type { AutomationLayoutContext } from "./shared";
import { AutomationBadge } from "./shared";

export default function BackofficeOrganisationAutomationScripts() {
  const { orgId, scripts, scriptsError } = useOutletContext<AutomationLayoutContext>();
  const [searchParams] = useSearchParams();
  const selectedScriptId = searchParams.get("script")?.trim() ?? "";
  const selectedScript = scripts.find((script) => script.id === selectedScriptId) ?? null;
  const isDetailVisible = Boolean(selectedScript);
  const basePath = `/backoffice/automations/${orgId}/scripts`;

  if (scriptsError) {
    return (
      <div className="border border-red-400/40 bg-red-500/8 p-4 text-sm text-red-700 dark:text-red-200">
        Could not load automation scripts from /workspace/automations: {scriptsError}
      </div>
    );
  }

  if (scripts.length === 0) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        No automation scripts are defined in this organisation&apos;s workspace.
      </div>
    );
  }

  return (
    <section className="grid gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
      <div
        className={`${isDetailVisible ? "hidden lg:block" : "block"} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Scripts
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Workspace scripts</h2>
          </div>
          <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
            {scripts.length} total
          </span>
        </div>

        <div className="mt-4 space-y-2">
          {scripts.map((script) => {
            const isSelected = script.id === selectedScriptId;
            return (
              <Link
                key={script.id}
                to={`${basePath}?script=${encodeURIComponent(script.id)}`}
                aria-current={isSelected ? "page" : undefined}
                className={
                  isSelected
                    ? "block w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-left text-[var(--bo-accent-fg)]"
                    : "block w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-left text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                }
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[var(--bo-fg)]">
                      {script.name}
                    </p>
                    <p className="mt-1 truncate font-mono text-xs text-[var(--bo-muted-2)]">
                      {script.key}
                    </p>
                    <p className="mt-1 truncate font-mono text-[11px] text-[var(--bo-muted-2)]">
                      {script.path}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <AutomationBadge tone="accent">Workspace</AutomationBadge>
                    <AutomationBadge tone={script.enabled ? "success" : "neutral"}>
                      {script.enabled ? "Enabled" : "Disabled"}
                    </AutomationBadge>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      <div
        className={`${isDetailVisible ? "block" : "hidden lg:block"} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        {selectedScript ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 lg:hidden">
                  <Link
                    to={basePath}
                    className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                  >
                    Back to list
                  </Link>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <AutomationBadge tone="accent">Workspace</AutomationBadge>
                  <AutomationBadge>{selectedScript.engine}</AutomationBadge>
                  <AutomationBadge tone={selectedScript.enabled ? "success" : "neutral"}>
                    {selectedScript.enabled ? "Enabled" : "Disabled"}
                  </AutomationBadge>
                </div>
                <div>
                  <h2 className="text-2xl font-semibold text-[var(--bo-fg)]">
                    {selectedScript.name}
                  </h2>
                  <p className="mt-1 font-mono text-xs text-[var(--bo-muted-2)]">
                    {selectedScript.key}
                  </p>
                </div>
              </div>

              <dl className="grid gap-3 text-sm text-[var(--bo-muted)] sm:grid-cols-4">
                <div>
                  <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Version
                  </dt>
                  <dd className="mt-1 font-semibold text-[var(--bo-fg)]">
                    v{selectedScript.version}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Relative path
                  </dt>
                  <dd className="mt-1 font-mono text-xs text-[var(--bo-fg)]">
                    {selectedScript.path}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Agent
                  </dt>
                  <dd className="mt-1">{selectedScript.agent ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Bindings
                  </dt>
                  <dd className="mt-1 font-semibold text-[var(--bo-fg)]">
                    {selectedScript.enabledBindingCount}/{selectedScript.bindingCount} enabled
                  </dd>
                </div>
              </dl>
            </div>

            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Filesystem location
              </p>
              <p className="mt-2 font-mono text-xs text-[var(--bo-fg)]">
                {selectedScript.absolutePath}
              </p>
              {Object.keys(selectedScript.env).length > 0 ? (
                <div className="mt-3">
                  <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    Binding env
                  </p>
                  <pre className="mt-2 overflow-auto font-mono text-xs text-[var(--bo-fg)]">
                    <code>{JSON.stringify(selectedScript.env, null, 2)}</code>
                  </pre>
                </div>
              ) : null}
            </div>

            <div className="border border-[color:var(--bo-border)] bg-[rgba(var(--bo-grid),0.08)]">
              <div className="border-b border-[color:var(--bo-border)] px-3 py-2 text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Bash script
              </div>
              <pre className="backoffice-scroll max-h-[36rem] overflow-auto px-3 py-3 font-mono text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
                <code>{selectedScript.script || "# Empty script"}</code>
              </pre>
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-64 items-center justify-center border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-6 text-center text-sm text-[var(--bo-muted)]">
            Select a script to inspect its filesystem-backed bash contents.
          </div>
        )}
      </div>
    </section>
  );
}
