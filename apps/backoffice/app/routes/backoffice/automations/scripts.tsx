import { Link, useLoaderData, useOutletContext, useSearchParams } from "react-router";

import type { Route } from "./+types/scripts";
import { loadAutomationScriptSource } from "./data";
import type { AutomationLayoutContext } from "./shared";
import { AutomationBadge, AutomationNotice } from "./shared";

const buildScriptLink = ({ basePath, scriptId }: { basePath: string; scriptId: string }) => {
  const params = new URLSearchParams({ script: scriptId });
  return `${basePath}?${params.toString()}`;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const selectedScriptId = url.searchParams.get("script")?.trim() ?? "";

  if (!selectedScriptId) {
    return {
      selectedScriptSource: { script: null, scriptError: null },
    };
  }

  return {
    selectedScriptSource: await loadAutomationScriptSource({
      context,
      orgId: params.orgId,
      scriptId: selectedScriptId,
    }),
  };
}

function ScriptSourcePanel({
  source,
}: {
  source: { script: string | null; scriptError: string | null };
}) {
  if (source.scriptError) {
    return null;
  }

  return (
    <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="border-b border-[color:var(--bo-border)] px-4 py-3">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Source</p>
      </div>
      <pre className="backoffice-scroll max-h-[42rem] overflow-auto px-4 py-4 font-mono text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
        <code>{source.script || "# Empty script"}</code>
      </pre>
    </div>
  );
}

export default function BackofficeOrganisationAutomationScripts() {
  const { orgId, scripts, scriptsError } = useOutletContext<AutomationLayoutContext>();
  const loaderData = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const selectedScriptId = searchParams.get("script")?.trim() ?? "";
  const selectedScript = scripts.find((script) => script.id === selectedScriptId) ?? null;
  const isDetailVisible = Boolean(selectedScript);
  const basePath = `/backoffice/automations/${orgId}/scripts`;
  const hasScriptLoadError = Boolean(scriptsError);

  if (hasScriptLoadError && scripts.length === 0) {
    return (
      <AutomationNotice tone="error">
        <p className="text-[10px] tracking-[0.22em] uppercase">Could not load automation scripts</p>
        <p className="mt-2 text-sm">{scriptsError}</p>
      </AutomationNotice>
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
    <section className="space-y-4">
      {hasScriptLoadError ? (
        <AutomationNotice tone="error">
          <p className="text-[10px] tracking-[0.22em] uppercase">Could not load all scripts</p>
          <p className="mt-2 text-sm">{scriptsError}</p>
        </AutomationNotice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
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
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
              {scripts.length} total
            </span>
          </div>

          <div className="mt-4 space-y-2">
            {scripts.map((script) => {
              const isSelected = script.id === selectedScriptId;
              const status = script.scriptLoadError
                ? "Error"
                : script.enabled
                  ? "Auto"
                  : "Workflow";

              return (
                <Link
                  key={script.id}
                  to={buildScriptLink({ basePath, scriptId: script.id })}
                  aria-current={isSelected ? "page" : undefined}
                  className={
                    isSelected
                      ? "block border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-4 text-left text-[var(--bo-accent-fg)]"
                      : "block border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-4 py-4 text-left text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
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
                      <AutomationBadge
                        tone={
                          script.scriptLoadError ? "error" : script.enabled ? "success" : "neutral"
                        }
                      >
                        {status}
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
                      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      Back to list
                    </Link>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <AutomationBadge>{selectedScript.engine}</AutomationBadge>
                    <AutomationBadge
                      tone={
                        selectedScript.scriptLoadError
                          ? "error"
                          : selectedScript.enabled
                            ? "success"
                            : "neutral"
                      }
                    >
                      {selectedScript.scriptLoadError
                        ? "Error"
                        : selectedScript.enabled
                          ? "Auto"
                          : "Workflow"}
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

                <dl className="grid gap-3 text-sm text-[var(--bo-muted)] sm:grid-cols-3">
                  <div>
                    <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                      Version
                    </dt>
                    <dd className="mt-1 font-semibold text-[var(--bo-fg)]">
                      {selectedScript.version != null ? `v${selectedScript.version}` : "—"}
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
                </dl>
              </div>

              {selectedScript.scriptLoadError || loaderData.selectedScriptSource.scriptError ? (
                <AutomationNotice tone="error">
                  <p className="text-[10px] tracking-[0.22em] uppercase">
                    Could not load script source
                  </p>
                  <p className="mt-2 text-sm whitespace-pre-wrap">
                    {loaderData.selectedScriptSource.scriptError ?? selectedScript.scriptLoadError}
                  </p>
                </AutomationNotice>
              ) : null}

              <ScriptSourcePanel source={loaderData.selectedScriptSource} />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-6 text-sm text-[var(--bo-muted)]">
                Select a script to inspect its source.
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
