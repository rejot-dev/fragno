import { BACKOFFICE_UI_COMPONENT_DEMOS, type BackofficeUiDemoCategory } from "@/backoffice-ui/demo";
import { BackofficeUiErrorBoundary, BackofficeUiRenderer } from "@/backoffice-ui/renderer";
import { BackofficePageHeader, BackofficeStatusLight } from "@/components/backoffice";

const DEMO_CATEGORIES: BackofficeUiDemoCategory[] = ["Layout", "Content", "Data", "Input"];

export function meta() {
  return [
    { title: "Generated UI Catalog · Backoffice Internals" },
    {
      name: "description",
      content: "Preview every component in the production Backoffice generated UI catalog.",
    },
  ];
}

export default function BackofficeGeneratedUiCatalogDemo() {
  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Internals", to: "/backoffice/internals" },
          { label: "Generated UI" },
        ]}
        eyebrow="Presentation system"
        code="GUI"
        title="Generated UI component catalog."
        description="Each card renders one production catalog component through the same parser, registry, and renderer used by codemode results."
        actions={<BackofficeStatusLight tone="live">Catalog valid</BackofficeStatusLight>}
      />

      {DEMO_CATEGORIES.map((category) => {
        const demos = BACKOFFICE_UI_COMPONENT_DEMOS.filter((demo) => demo.category === category);

        return (
          <section key={category} aria-labelledby={`generated-ui-${category.toLowerCase()}`}>
            <div className="mb-2 flex items-end justify-between gap-3">
              <div>
                <p className="text-[9px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  Component group
                </p>
                <h2
                  id={`generated-ui-${category.toLowerCase()}`}
                  className="mt-1 text-lg font-semibold text-[var(--bo-fg)]"
                >
                  {category}
                </h2>
              </div>
              <span className="font-mono text-[10px] text-[var(--bo-muted-2)] tabular-nums">
                {demos.length} components
              </span>
            </div>

            <div className="grid min-w-0 gap-3 xl:grid-cols-2">
              {demos.map((demo) => (
                <article
                  key={demo.component}
                  className="bo-fragment-surface bo-panel-surface flex min-w-0 flex-col bg-[var(--bo-panel)]"
                >
                  <div className="border-b border-[color:var(--bo-border)] px-4 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="font-mono text-sm font-semibold text-[var(--bo-fg)]">
                        {demo.component}
                      </h3>
                      <span className="text-[8px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                        {category}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-[var(--bo-muted)]">
                      {demo.description}
                    </p>
                  </div>

                  <div className="backoffice-scroll min-h-36 min-w-0 flex-1 overflow-x-auto bg-[var(--bo-panel-2)] p-4">
                    <BackofficeUiErrorBoundary
                      fallback={
                        <div
                          role="alert"
                          className="border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] p-3 text-xs text-[var(--bo-failed)]"
                        >
                          {demo.component} failed to render.
                        </div>
                      }
                    >
                      <BackofficeUiRenderer ui={demo.result.$ui} />
                    </BackofficeUiErrorBoundary>
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
