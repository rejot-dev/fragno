import { Suspense, use } from "react";

/** Whether the `scope-probe` flag is on in the page's scope, and which scope decided it. */
export type ScopeProbe =
  | { kind: "off" }
  | { kind: "on"; decidedBy: string }
  | { kind: "failed"; message: string };

type ScopeProbePresentation = "bar" | "phone";

export function StreamedScopeProbe({
  scopeProbe,
  presentation,
}: {
  scopeProbe: Promise<ScopeProbe> | null;
  /** Phones show the deciding scope alone, as their header has little room. */
  presentation: ScopeProbePresentation;
}) {
  if (!scopeProbe) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <ScopeProbeBadge scopeProbe={scopeProbe} presentation={presentation} />
    </Suspense>
  );
}

function ScopeProbeBadge({
  scopeProbe,
  presentation,
}: {
  scopeProbe: Promise<ScopeProbe>;
  presentation: ScopeProbePresentation;
}) {
  const probe = use(scopeProbe);
  const wrapper =
    presentation === "bar" ? "flex shrink-0 items-center px-3" : "flex max-w-[40%] min-w-0";
  const pill = "inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs";
  switch (probe.kind) {
    case "off":
      return null;
    case "on":
      return (
        <div className={wrapper}>
          <span
            title="The scope-probe feature flag is on here"
            aria-label={`scope-probe on, decided by ${probe.decidedBy}`}
            className={`${pill} border-[color:var(--bo-border)] bg-[var(--bo-panel)] text-[var(--bo-muted)]`}
          >
            <span aria-hidden="true">🚩</span>
            {presentation === "bar" ? <span>decided by</span> : null}
            <code className="truncate font-mono text-[var(--bo-fg)]">{probe.decidedBy}</code>
          </span>
        </div>
      );
    case "failed":
      return (
        <div className={wrapper}>
          <span
            title={probe.message}
            className={`${pill} border-[color:var(--bo-failed)] text-[var(--bo-failed)]`}
          >
            <span aria-hidden="true">🚩</span>
            <span className="truncate">
              {presentation === "bar" ? "flags unavailable" : "unavailable"}
            </span>
          </span>
        </div>
      );
    default:
      throw new Error("Unsupported scope probe.", { cause: probe satisfies never });
  }
}
