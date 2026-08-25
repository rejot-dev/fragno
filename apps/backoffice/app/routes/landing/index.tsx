import "../../backoffice.css";

import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

import { BackofficeFragmentMark } from "@/components/backoffice/fragment-mark";

import { LandingFooter } from "./landing-footer";
import { LandingPhilosophy } from "./landing-philosophy";
import { LandingWorkflow } from "./landing-workflow";
import { LandingSystem } from "./system/landing-system";

export function meta() {
  return [
    { title: "Backoffice" },
    {
      name: "description",
      content: "A controlled workspace for AI workflows, files, events, and integrations.",
    },
  ];
}

export default function LandingPage() {
  return (
    <main
      data-backoffice-root
      className="min-h-svh overflow-hidden bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <header className="mx-auto flex min-h-16 w-full max-w-[1180px] items-center justify-between px-5 sm:px-8 lg:px-12">
        <Link
          to="/"
          className="flex min-h-11 items-center gap-3 text-[10px] font-bold tracking-[0.16em] text-[var(--bo-fg)] uppercase no-underline"
          aria-label="ReJot Backoffice home"
        >
          <BackofficeFragmentMark size="md" />
          ReJot Backoffice
        </Link>
        <Link
          to="/backoffice"
          className="inline-flex min-h-11 items-center gap-2 text-[10px] font-bold tracking-[0.14em] text-[var(--bo-muted)] uppercase no-underline transition-colors duration-150 hover:text-[var(--bo-fg)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--bo-accent)]"
        >
          Open app
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </header>

      <section className="mx-auto flex min-h-[clamp(430px,62svh,680px)] w-full max-w-[1180px] flex-col justify-center px-5 pt-14 pb-16 sm:px-8 lg:px-12 lg:pt-20 lg:pb-24">
        <h1 className="max-w-[1040px] text-[clamp(3.5rem,8.8vw,8.4rem)] leading-[0.88] font-[560] tracking-[-0.075em] text-balance">
          Automate your
          <br />
          <span className="text-[var(--bo-muted-2)]">business with AI</span>
        </h1>
        <p className="mt-9 max-w-2xl text-[clamp(0.95rem,1.4vw,1.1rem)] leading-7 text-pretty text-[var(--bo-muted)]">
          Turn business processes into workflows. Connect your tools and apps to Backoffice and let
          AI build automations. Deterministic and auditable.
        </p>
      </section>

      <LandingWorkflow />
      <LandingSystem />
      <LandingPhilosophy />

      <LandingFooter />
    </main>
  );
}
