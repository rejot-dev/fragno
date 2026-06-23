import { Link, useLoaderData, useOutletContext, useSearchParams } from "react-router";

import type { Route } from "./+types/scripts";
import { loadAutomationScriptSource } from "./data.server";
import { automationScopeFromRouteParams, automationScopeTabPath } from "./scope";
import type { AutomationLayoutContext } from "./shared";
import { AutomationNotice } from "./shared";

const buildScriptLink = ({ basePath, scriptId }: { basePath: string; scriptId: string }) => {
  const params = new URLSearchParams({ script: scriptId });
  return `${basePath}?${params.toString()}`;
};

const isRouterScript = (script: { path: string; key: string; name: string }) =>
  script.path === "router.cm.js" || script.key === "router.cm";

const compareScriptsWithRouterFirst = <TScript extends { path: string; key: string; name: string }>(
  left: TScript,
  right: TScript,
) => {
  const routerOrder = Number(isRouterScript(right)) - Number(isRouterScript(left));
  if (routerOrder !== 0) {
    return routerOrder;
  }

  return left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const selectedScriptId = url.searchParams.get("script")?.trim() ?? "";

  if (!selectedScriptId) {
    return {
      selectedScriptSource: { script: null, scriptError: null },
    };
  }

  return {
    selectedScriptSource: await loadAutomationScriptSource({
      request,
      context,
      scope: automationScopeFromRouteParams(params),
      scriptId: selectedScriptId,
    }),
  };
}

function ScriptSourcePanel({
  absolutePath,
  source,
}: {
  absolutePath: string;
  source: { script: string | null; scriptError: string | null };
}) {
  if (source.scriptError) {
    return null;
  }

  return (
    <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="border-b border-[color:var(--bo-border)] px-4 py-3">
        <p className="font-mono text-[11px] break-all text-[var(--bo-muted-2)]">{absolutePath}</p>
      </div>
      <pre className="backoffice-scroll max-h-[42rem] overflow-auto px-4 py-4 font-mono text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
        <code>{source.script || "# Empty script"}</code>
      </pre>
    </div>
  );
}

export default function BackofficeOrganisationAutomationScripts() {
  const { selectedScope, scripts, scriptsError } = useOutletContext<AutomationLayoutContext>();
  const loaderData = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const selectedScriptId = searchParams.get("script")?.trim() ?? "";
  const selectedScript = scripts.find((script) => script.id === selectedScriptId) ?? null;
  const isDetailVisible = Boolean(selectedScript);
  const basePath = automationScopeTabPath(selectedScope, "scripts");
  const hasScriptLoadError = Boolean(scriptsError);
  const scriptSections = [
    {
      id: "system" as const,
      label: "System",
      scripts: scripts
        .filter((script) => script.layer === "system")
        .sort(compareScriptsWithRouterFirst),
    },
    {
      id: "workspace" as const,
      label: "Workspace",
      scripts: scripts
        .filter((script) => script.layer === "workspace")
        .sort(compareScriptsWithRouterFirst),
    },
  ].filter((section) => section.scripts.length > 0);

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
        No automation scripts are defined for this organisation.
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
          <div>
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Scripts
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Automation scripts</h2>
          </div>

          <div className="mt-4 space-y-5">
            {scriptSections.map((section, sectionIndex) => (
              <div key={section.id} className="space-y-2">
                <div
                  className={
                    sectionIndex > 0 ? "flex items-center gap-3 pt-2" : "flex items-center gap-3"
                  }
                >
                  <div className="h-px flex-1 bg-[var(--bo-border)]" />
                  <span className="text-[9px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                    {section.label}
                  </span>
                  <div className="h-px flex-1 bg-[var(--bo-border)]" />
                </div>

                <div className="space-y-1">
                  {section.scripts.map((script) => {
                    const isSelected = script.id === selectedScriptId;

                    return (
                      <Link
                        key={script.id}
                        to={buildScriptLink({ basePath, scriptId: script.id })}
                        preventScrollReset
                        aria-current={isSelected ? "page" : undefined}
                        className={
                          isSelected
                            ? "block border-l-2 border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2.5 text-left"
                            : "block border-l-2 border-transparent px-3 py-2.5 text-left transition-colors hover:border-[color:var(--bo-border-strong)] hover:bg-[var(--bo-panel-2)]"
                        }
                      >
                        <p className="truncate text-sm font-medium text-[var(--bo-fg)]">
                          {script.name}
                        </p>
                        <p className="mt-1 truncate font-mono text-[11px] text-[var(--bo-muted-2)]">
                          {script.path}
                        </p>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
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
                  <div>
                    <h2 className="text-2xl font-semibold text-[var(--bo-fg)]">
                      {selectedScript.name}
                    </h2>
                  </div>
                </div>
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

              <ScriptSourcePanel
                absolutePath={selectedScript.absolutePath}
                source={loaderData.selectedScriptSource}
              />
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
