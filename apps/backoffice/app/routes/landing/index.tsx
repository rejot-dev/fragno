import "../../backoffice.css";

import { Link } from "react-router";

import { CapabilityGrid } from "./capability-grid";
import { ProductVisual } from "./product-visual";
import { WorkflowSection } from "./workflow-section";
import { WorkspaceSection } from "./workspace-section";

export function meta() {
  return [
    { title: "Backoffice" },
    {
      name: "description",
      content: "A programmable workspace for events, automations, files, and integrations.",
    },
  ];
}

function ProductMark() {
  return (
    <span className="bo-fragment-mark" data-size="md" data-palette="blue" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

export default function LandingPage() {
  return (
    <main
      data-backoffice-root
      className="bo-grid-backdrop min-h-svh overflow-hidden bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <header className="relative z-10 flex min-h-[72px] items-center justify-between border-b border-[color:var(--bo-border)] bg-[color-mix(in_srgb,var(--bo-bg)_86%,transparent)] px-[clamp(1.25rem,4vw,4.5rem)] backdrop-blur-xl max-[560px]:min-h-[62px]">
        <Link
          to="/"
          className="flex min-h-11 items-center gap-3 text-xs font-bold tracking-[0.16em] text-[var(--bo-fg)] no-underline"
          aria-label="Backoffice home"
        >
          <ProductMark />
          <span>BACKOFFICE</span>
          <span className="text-[var(--bo-muted-2)] max-[560px]:hidden">/ CONTROL</span>
        </Link>
        <Link
          to="/backoffice"
          className="flex min-h-11 items-center gap-5 text-[10px] font-bold tracking-[0.2em] text-[var(--bo-muted)] no-underline transition-colors duration-150 hover:text-[var(--bo-accent)]"
        >
          <span>ENTER</span>
          <span aria-hidden="true">↗</span>
        </Link>
      </header>

      <section className="relative mx-auto grid min-h-[calc(100svh-72px)] w-full max-w-[1600px] grid-cols-[minmax(280px,0.78fr)_minmax(480px,1.22fr)] items-center px-[clamp(1.25rem,7vw,7.5rem)] py-[clamp(3rem,7vw,7rem)] max-[900px]:grid-cols-1 max-[900px]:pt-16 max-[560px]:min-h-0 max-[560px]:py-12 max-[560px]:pb-4">
        <div className="relative z-5">
          <span className="bo-product-code">OPERATIONS / PROGRAMMABLE</span>
          <h1 className="my-5 mt-7 max-w-[700px] text-[clamp(3.5rem,7.4vw,8.2rem)] leading-[0.86] font-[520] tracking-[-0.075em] text-balance max-[900px]:text-[clamp(3.6rem,15vw,7rem)] max-[560px]:mt-5 max-[560px]:text-[clamp(3.25rem,17vw,5.5rem)]">
            Everything,
            <br />
            <span className="text-transparent [-webkit-text-stroke:1.5px_var(--bo-muted-2)]">
              in view.
            </span>
          </h1>
          <p className="m-0 max-w-lg text-[clamp(0.95rem,1.2vw,1.1rem)] leading-[1.65] text-pretty text-[var(--bo-muted)]">
            Automate work, inspect every event, and keep the context close.
          </p>
          <Link
            to="/backoffice"
            className="bo-control-surface mt-8 inline-flex min-h-12 items-center justify-between gap-12 bg-[var(--bo-panel)] py-0 pr-2 pl-4 text-[11px] font-bold tracking-[0.12em] text-[var(--bo-fg)] uppercase no-underline transition-[color,background-color,scale] duration-150 hover:bg-[var(--bo-accent-bg)] hover:text-[var(--bo-accent-strong)] active:scale-[0.96]"
          >
            Open backoffice
            <span
              className="grid size-[34px] place-items-center bg-[var(--bo-accent)] text-base text-white"
              aria-hidden="true"
            >
              →
            </span>
          </Link>
        </div>
        <ProductVisual />
      </section>

      <CapabilityGrid />
      <WorkflowSection />
      <WorkspaceSection />

      <section className="border-t border-[color:var(--bo-border)] bg-[var(--bo-accent-bg)] px-[clamp(1.25rem,7vw,7.5rem)] py-[clamp(5rem,10vw,10rem)]">
        <div className="mx-auto flex max-w-[1380px] items-end justify-between gap-10 max-[760px]:block">
          <div>
            <span className="font-mono text-[9px] font-bold tracking-[0.2em] text-[var(--bo-accent)]">
              READY WHEN YOU ARE
            </span>
            <h2 className="mt-5 text-[clamp(3.2rem,7vw,8rem)] leading-[0.86] font-[520] tracking-[-0.075em] text-balance">
              Make the work
              <br />
              visible.
            </h2>
          </div>
          <Link
            to="/backoffice"
            className="bo-control-surface inline-flex min-h-14 min-w-[220px] items-center justify-between bg-[var(--bo-accent)] py-0 pr-2 pl-5 text-[11px] font-bold tracking-[0.14em] text-white uppercase no-underline transition-[background-color,scale] duration-150 hover:bg-[var(--bo-accent-strong)] active:scale-[0.96] max-[760px]:mt-10"
          >
            Enter backoffice
            <span
              className="grid size-10 place-items-center bg-white/15 text-lg"
              aria-hidden="true"
            >
              ↗
            </span>
          </Link>
        </div>
      </section>

      <footer className="relative z-10 flex min-h-[52px] items-center justify-between border-t border-[color:var(--bo-border)] bg-[var(--bo-bg)] px-[clamp(1.25rem,4vw,4.5rem)] font-mono text-[8px] tracking-[0.17em] text-[var(--bo-muted-2)]">
        <span className="max-[560px]:hidden">EVENTS / ROUTES / WORKFLOWS / FILES</span>
        <span className="flex items-center gap-2 text-[var(--bo-live)]">
          <i className="size-[5px] bg-current shadow-[0_0_0_3px_color-mix(in_srgb,currentColor_14%,transparent)]" />
          ALL SERVICES ONLINE
        </span>
        <span>BACKOFFICE</span>
      </footer>
    </main>
  );
}
