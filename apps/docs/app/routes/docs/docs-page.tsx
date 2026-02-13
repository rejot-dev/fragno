import type { Route } from "./+types/docs-page";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import { source } from "@/lib/source";
import type * as PageTree from "fumadocs-core/page-tree";
import browserCollections from "fumadocs-mdx:collections/browser";
import { baseOptions } from "@/lib/layout.shared";
import { CopyMarkdownButton } from "@/components/copy-markdown-button";
import { ViewOptions } from "@/components/page-actions";
import { getMDXComponents } from "@/lib/mdx-components";
import { createElement, createContext, useContext } from "react";
import { isMarkdownPreferred } from "fumadocs-core/negotiation";
import { iconComponents } from "@/lib/icons";
import { buildMarkdownApiUrl } from "./markdown-redirect";

/**
 * Context to pass loader data to the MDX component
 */
const PageDataContext = createContext<{
  url: string;
  path: string;
  processedMarkdown: string;
} | null>(null);

function usePageData() {
  const context = useContext(PageDataContext);
  if (!context) {
    throw new Error("usePageData must be used within PageDataContext.Provider");
  }
  return context;
}

/**
 * Hydrates icon names (strings) in the page tree to React components.
 *
 * Why recursion is needed:
 * The docs tree is hierarchical - folders contain subfolders and pages.
 * Icons can appear at any level, so we traverse the entire tree.
 *
 * Why `any` type:
 * Fumadocs' PageTree is a complex dynamic structure not fully typed.
 * We preserve the structure and only modify icon properties.
 *
 * Icon hydration:
 * - String icon names (from meta.json) → React elements
 * - Uses only explicitly imported icons from iconComponents
 * - Missing icons are silently ignored (no icon displayed)
 */
function hydrateIcons(node: PageTree.Root): PageTree.Root;
function hydrateIcons(node: unknown): unknown {
  if (!node || typeof node !== "object") {
    return node;
  }

  const nodeObj = node as Record<string, unknown>;
  const hydrated = { ...nodeObj };

  // Hydrate string icon names to React components
  if (typeof hydrated.icon === "string") {
    const iconName = hydrated.icon;
    if (iconName in iconComponents) {
      const IconComponent = iconComponents[iconName as keyof typeof iconComponents];
      hydrated.icon = createElement(IconComponent);
    } else {
      throw new Error(
        `Icon ${iconName} not found in client bundle. Add it to the iconComponents object in app/lib/icons.tsx.`,
      );
    }
  }

  // Recursively hydrate children (folders → subfolders → pages)
  if (Array.isArray(hydrated.children)) {
    hydrated.children = hydrated.children.map((child) => hydrateIcons(child));
  }

  if (Array.isArray(hydrated.index)) {
    hydrated.index = hydrated.index.map((item) => hydrateIcons(item));
  }

  return hydrated;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const isMarkdown =
    request.url.endsWith(".md") || request.url.endsWith(".mdx") || isMarkdownPreferred(request);
  const splat = params["*"]?.replace(/\.mdx?$/, "");

  const slugs = splat.split("/").filter((v) => v.length > 0);
  const page = source.getPage(slugs);

  if (!page) {
    throw new Response("Not found", { status: 404 });
  }

  if (isMarkdown) {
    return Response.redirect(buildMarkdownApiUrl(slugs, request.url));
  }

  const processedMarkdown = await page.data.getText?.("processed");
  const tree = source.getPageTree();

  // Tree contains icon names as strings which is JSON-serializable
  return {
    path: page.path,
    tree,
    url: page.url,
    processedMarkdown,
    title: page.data.title,
    description: page.data.description,
  };
}

const clientLoader = browserCollections.docs.createClientLoader({
  component({ toc, default: Mdx, frontmatter }) {
    const { url, path, processedMarkdown } = usePageData();

    return (
      <DocsPage toc={toc} full={frontmatter.full}>
        <title>{frontmatter.title}</title>
        <meta name="description" content={frontmatter.description} />
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <div className="-mt-6 flex flex-row items-center gap-2 border-b pb-6 pt-2">
          <CopyMarkdownButton markdownText={processedMarkdown} />
          <ViewOptions
            markdownUrl={`${url}.md`}
            githubUrl={`https://github.com/rejot-dev/fragno/tree/main/apps/docs/content/docs/${path}`}
            linkOptions={["markdown", "github", "chatgpt", "claude", "t3-chat"]}
          />
        </div>
        <DocsBody>
          <Mdx components={{ ...getMDXComponents() }} />
        </DocsBody>
      </DocsPage>
    );
  },
});

export default function Page({ loaderData }: Route.ComponentProps) {
  const { tree, path, url, processedMarkdown } = loaderData;
  const Content = clientLoader.getComponent(path);
  const hydratedTree = hydrateIcons(tree as PageTree.Root);

  return (
    <div
      // The docs layout uses `--fd-banner-height` to offset its fixed elements.
      // Since we render it under the site header (HomeLayout), we bump this so
      // the sidebar/top controls don't sit behind the header.
      style={{ ["--fd-banner-height" as never]: "56px" }}
    >
      <DocsLayout
        {...baseOptions()}
        tree={hydratedTree}
        sidebar={{
          collapsible: false,
        }}
      >
        <PageDataContext.Provider value={{ url, path, processedMarkdown }}>
          <Content />
        </PageDataContext.Provider>
      </DocsLayout>
    </div>
  );
}
