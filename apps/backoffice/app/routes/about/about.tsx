import "@fragno-private/design-system/components.css";

import { LandingAbout } from "@fragno-private/design-system/landing/about";

import { LandingFooter } from "../landing/landing-footer";
import { LandingHeader } from "../landing/landing-header";

export function meta() {
  return [
    { title: "About us · Leyway" },
    {
      name: "description",
      content: "Who builds Leyway, what we believe about automation, and who backs us.",
    },
    { property: "og:title", content: "About us" },
  ];
}

export default function AboutPage() {
  return (
    <div
      data-backoffice-root
      className="flex min-h-svh flex-col bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <LandingHeader />
      <main className="max-w-landing mx-auto w-full flex-1 px-7 pt-14 pb-24 sm:px-8 lg:px-12 lg:pt-20">
        <LandingAbout />
      </main>
      <LandingFooter />
    </div>
  );
}
