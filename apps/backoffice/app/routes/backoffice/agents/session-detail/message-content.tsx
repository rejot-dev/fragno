import {
  MarkdownImage,
  MarkdownText as ChatMarkdownText,
} from "@fragno-private/backoffice-chat/messages/markdown";
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

import { siteHostOf, siteHostOrigin } from "@/artifacts/sites/site-host-names";
import {
  FileImage,
  FileLink,
  ScopedFileImage,
  ScopedFileLink,
} from "@/components/backoffice/file-scope";

import { rehypePlugins, remarkPlugins } from "./file-path-links";

const markdownComponents = {
  img: MarkdownImage,
  // Only rehypeFileDestinations creates these elements, and only with a validated path and scope.
  "file-link": FileLink as ComponentType,
  "scoped-file-link": ScopedFileLink as ComponentType,
  "file-image": FileImage as ComponentType,
  "scoped-file-image": ScopedFileImage as ComponentType,
  "unavailable-image": MarkdownImage,
};

// Outside the Backoffice layout no sites domain is known, so every link asks before it opens.
const SitesDomainContext = createContext<string | null>(null);

/** Lets links to sites, which Backoffice serves under `domain`, open without asking first. */
export function SitesDomainProvider({
  domain,
  children,
}: {
  domain: string | null;
  children: ReactNode;
}) {
  return <SitesDomainContext.Provider value={domain}>{children}</SitesDomainContext.Provider>;
}

function isSiteUrl(href: string, domain: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const host = siteHostOf(url, domain);
  return typeof host === "string" && url.origin === siteHostOrigin(host, domain);
}

/** Markdown whose workspace paths link to, and show, the scope's files. */
export function MarkdownText({ text, className }: { text: string; className?: string }) {
  const sitesDomain = useContext(SitesDomainContext);
  return (
    <ChatMarkdownText
      text={text}
      className={className}
      components={markdownComponents}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      opensWithoutAsking={(url) => sitesDomain !== null && isSiteUrl(url, sitesDomain)}
    />
  );
}
