import "./legal-document.css";
import "@fragno-private/design-system/components.css";

import { Link } from "react-router";
import rehypeSlug from "rehype-slug";
import { type Components, defaultRehypePlugins, Streamdown } from "streamdown";

import privacyPolicy from "../../../content/legal/privacy-policy.md?raw";
import subprocessors from "../../../content/legal/subprocessors.md?raw";
import { LandingFooter } from "../landing/landing-footer";
import { LandingHeader } from "../landing/landing-header";
import type { Route } from "./+types/legal-document";

const LEGAL_DOCUMENTS = {
  privacy: {
    title: "Privacy policy",
    description: "How Leyway handles personal data, where it is stored, and the rights you have.",
    markdown: privacyPolicy,
  },
  subprocessors: {
    title: "Subprocessors",
    description: "The service providers Leyway uses to process personal data, and where they do.",
    markdown: subprocessors,
  },
};

type LegalDocumentName = keyof typeof LEGAL_DOCUMENTS;

// Slugs come last, after Streamdown's sanitizer, which would otherwise prefix every heading id.
const rehypePlugins = [...Object.values(defaultRehypePlugins), rehypeSlug];

const components: Components = {
  // Streamdown opens every link in a new tab behind a confirmation dialog, which suits model output
  // but not our own pages linking to each other.
  a: ({ href, children }) =>
    href?.startsWith("/") ? <Link to={href}>{children}</Link> : <a href={href}>{children}</a>,
};

export function loader({ params }: Route.LoaderArgs) {
  if (!Object.hasOwn(LEGAL_DOCUMENTS, params.document)) {
    throw new Response("Not Found", { status: 404 });
  }
  return { document: params.document as LegalDocumentName };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) {
    return [];
  }
  const { title, description } = LEGAL_DOCUMENTS[loaderData.document];
  return [
    { title: `${title} · Leyway` },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
  ];
}

export default function LegalDocument({ loaderData }: Route.ComponentProps) {
  return (
    <div
      data-backoffice-root
      className="flex min-h-svh flex-col bg-[var(--bo-bg)] font-sans text-[var(--bo-fg)]"
    >
      <LandingHeader />
      <main className="mx-auto w-full max-w-[1180px] flex-1 px-7 pt-14 pb-24 sm:px-8 lg:px-12 lg:pt-20">
        <Streamdown
          mode="static"
          className="legal-document"
          controls={false}
          rehypePlugins={rehypePlugins}
          components={components}
        >
          {LEGAL_DOCUMENTS[loaderData.document].markdown}
        </Streamdown>
      </main>
      <LandingFooter />
    </div>
  );
}
