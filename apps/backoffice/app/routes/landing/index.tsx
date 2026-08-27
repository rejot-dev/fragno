import "../../backoffice.css";

import { LandingFooter } from "./landing-footer";
import { LandingHeader } from "./landing-header";
import { LandingPhilosophy } from "./landing-philosophy";
import { LandingWorkflow } from "./landing-workflow";
import { LandingSystem } from "./system/landing-system";

export function meta() {
  const title = "ReJot Backoffice — Automate your business with AI";
  const description =
    "Turn business processes into deterministic workflows that connect tools, route events, preserve context, and run under your control.";
  const ogImage = "https://backoffice.rejot.dev/og-image.png";

  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:image", content: ogImage },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: "ReJot Backoffice — Automate your business with AI" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: ogImage },
  ];
}

export default function LandingPage() {
  return (
    <main
      data-backoffice-root
      className="min-h-svh overflow-hidden bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <LandingHeader />

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
