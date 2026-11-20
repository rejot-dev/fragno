import "@fragno-private/design-system/components.css";

import { LANDING_CASES, LandingCase } from "@fragno-private/design-system/landing/cases";

import { LandingFooter } from "../landing/landing-footer";
import { LandingHeader } from "../landing/landing-header";
import type { Route } from "./+types/case";

type CaseSlug = keyof typeof LANDING_CASES;

export function loader({ params }: Route.LoaderArgs) {
  if (!Object.hasOwn(LANDING_CASES, params.case)) {
    throw new Response("Not Found", { status: 404 });
  }
  return { slug: params.case as CaseSlug };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) {
    return [];
  }
  const { headline, summary } = LANDING_CASES[loaderData.slug];
  return [
    { title: `${headline} · Leyway` },
    { name: "description", content: summary },
    { property: "og:title", content: headline },
    { property: "og:description", content: summary },
  ];
}

export default function CasePage({ loaderData }: Route.ComponentProps) {
  return (
    <div
      data-backoffice-root
      className="flex min-h-svh flex-col bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <LandingHeader />
      <main className="max-w-landing mx-auto w-full flex-1 px-7 pt-14 pb-24 sm:px-8 lg:px-12 lg:pt-20">
        <LandingCase slug={loaderData.slug} />
      </main>
      <LandingFooter />
    </div>
  );
}
