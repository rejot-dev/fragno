import "@fragno-private/design-system/components.css";

import { LandingHero } from "@fragno-private/design-system/landing/hero";
import { LandingHomeSections } from "@fragno-private/design-system/landing/home";

import { LandingFooter } from "./landing-footer";
import { LandingHeader } from "./landing-header";

export function meta() {
  const title = "ReJot Backoffice — AI that shows its work";
  const description =
    "Describe how your business runs, and Backoffice writes it as workflows you can read. They run the same way every time, ask before they act, and record every step.";
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
    { property: "og:image:alt", content: title },
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

      <LandingHero />
      <LandingHomeSections />

      <LandingFooter />
    </main>
  );
}
