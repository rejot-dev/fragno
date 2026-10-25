import {
  BACKOFFICE_UI_COMPONENT_DEMOS,
  type BackofficeUiDemoCategory,
} from "@fragno-private/backoffice-ui/demo";
import {
  BackofficeUiErrorBoundary,
  BackofficeUiRenderer,
} from "@fragno-private/backoffice-ui/renderer";
import { InlineAlert } from "@fragno-private/design-system/inline-alert";
import { SurfacePanel } from "@fragno-private/design-system/surface-panel";

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
    <>
      <p className="max-w-3xl text-sm text-pretty text-[var(--bo-muted)]">
        Each panel renders one production catalog component through the same parser, registry, and
        renderer used by codemode results.
      </p>
      {DEMO_CATEGORIES.map((category) => {
        const demos = BACKOFFICE_UI_COMPONENT_DEMOS.filter((demo) => demo.category === category);

        return (
          <section
            key={category}
            aria-labelledby={`generated-ui-${category.toLowerCase()}`}
            className="flex flex-col gap-3"
          >
            <h2
              id={`generated-ui-${category.toLowerCase()}`}
              className="text-sm font-semibold text-[var(--bo-fg)]"
            >
              {category}{" "}
              <span className="font-normal text-[var(--bo-muted-2)] tabular-nums">
                · {demos.length} components
              </span>
            </h2>

            <div className="grid min-w-0 gap-3 xl:grid-cols-2">
              {demos.map((demo) => (
                <SurfacePanel key={demo.component} caption={demo.component} actions={null}>
                  <p className="border-t border-[color:var(--bo-border)] px-4 py-3 text-xs leading-5 text-pretty text-[var(--bo-muted)]">
                    {demo.description}
                  </p>
                  <div className="backoffice-scroll min-h-36 min-w-0 overflow-x-auto border-t border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
                    <BackofficeUiErrorBoundary
                      fallback={<InlineAlert>{demo.component} failed to render.</InlineAlert>}
                    >
                      <BackofficeUiRenderer ui={demo.result.$ui} />
                    </BackofficeUiErrorBoundary>
                  </div>
                </SurfacePanel>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
