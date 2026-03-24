import browserCollections from "fumadocs-mdx:collections/browser";
import { useCopyButton } from "fumadocs-ui/utils/use-copy-button";
import { ArrowLeft, Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { ComponentPropsWithoutRef } from "react";
import { Link } from "react-router";

import { LevelProvider } from "@/components/levels-context";
import { cn } from "@/lib/cn";
import { getMDXComponents } from "@/lib/mdx-components";
import { blogSource } from "@/lib/source";

import type { Route } from "./+types/blog-post";

const prose = "text-base leading-[1.8] text-[var(--editorial-muted)]";
const eyebrow = "text-base font-bold uppercase tracking-[0.14em] text-[var(--editorial-primary)]";
const metaText = "text-base uppercase tracking-[0.15em] text-[var(--editorial-muted)]";
const panelTitle =
  "mb-4 text-base font-bold uppercase tracking-[0.18em] text-[var(--editorial-muted)]";
const panelClass =
  "bg-[var(--editorial-surface-low)] p-5 shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]";
const articleContentClass =
  "max-w-none text-[var(--editorial-muted)] [&_h1]:mt-12 [&_h1]:mb-5 [&_h1]:text-4xl [&_h1]:leading-[1.1] [&_h1]:font-bold [&_h1]:tracking-[-0.03em] [&_h1]:text-[var(--editorial-ink)] [&_h2]:mt-12 [&_h2]:mb-5 [&_h2]:text-3xl [&_h2]:leading-[1.1] [&_h2]:font-bold [&_h2]:tracking-[-0.03em] [&_h2]:text-[var(--editorial-ink)] [&_h3]:mt-12 [&_h3]:mb-5 [&_h3]:text-2xl [&_h3]:leading-[1.1] [&_h3]:font-bold [&_h3]:tracking-[-0.03em] [&_h3]:text-[var(--editorial-ink)] [&_h4]:mt-10 [&_h4]:mb-4 [&_h4]:text-xl [&_h4]:leading-[1.15] [&_h4]:font-bold [&_h4]:tracking-[-0.03em] [&_h4]:text-[var(--editorial-ink)] [&_p]:my-5 [&_p]:text-base [&_p]:leading-[1.8] [&_li]:my-2 [&_li]:text-base [&_li]:leading-[1.8] [&_blockquote]:my-5 [&_blockquote]:border-l [&_blockquote]:border-[var(--editorial-ghost-border)] [&_blockquote]:pl-4 [&_blockquote]:text-base [&_blockquote]:leading-[1.8] [&_strong]:text-[var(--editorial-ink)] [&_a]:text-[var(--editorial-secondary)] [&_a]:transition-colors [&_a:hover]:opacity-80 [&_.shiki]:my-8 [&_.shiki]:grid [&_.shiki]:w-full [&_.shiki]:min-w-0 [&_.shiki]:max-w-full [&_.shiki]:overflow-hidden [&_.shiki]:bg-[var(--editorial-surface-low)] [&_.shiki]:shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] [&_[role=tabpanel]_.shiki]:my-0 [&_.shiki_pre]:my-0 [&_.shiki_pre]:overflow-visible [&_.shiki_pre]:bg-transparent [&_.shiki_pre]:px-4 [&_.shiki_pre]:py-0 [&_.shiki_pre]:shadow-none [&_p_code]:rounded-sm [&_p_code]:bg-[color-mix(in_srgb,var(--editorial-surface-low)_92%,transparent)] [&_p_code]:px-1.5 [&_p_code]:py-0.5 [&_p_code]:font-mono [&_p_code]:text-[0.92em] [&_li_code]:rounded-sm [&_li_code]:bg-[color-mix(in_srgb,var(--editorial-surface-low)_92%,transparent)] [&_li_code]:px-1.5 [&_li_code]:py-0.5 [&_li_code]:font-mono [&_li_code]:text-[0.92em] [&_ul]:my-5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_hr]:my-10 [&_hr]:border-[var(--editorial-ghost-border)]";

export async function loader({ params }: Route.LoaderArgs) {
  const page = blogSource.getPage([params.slug]);
  if (!page) {
    throw new Response("Not found", { status: 404 });
  }

  const publishDateSource = "date" in page.data ? page.data.date : new Date();
  const publishDate = new Date(publishDateSource);
  if (Number.isNaN(publishDate.getTime())) {
    throw new Error(`Invalid publish date for blog post at ${page.url}`);
  }

  const author = "author" in page.data ? page.data.author : undefined;

  return {
    slug: params.slug,
    path: page.path,
    url: page.url,
    title: page.data.title,
    description: page.data.description ?? "Read the latest updates from the Fragno blog.",
    publishDateIso: publishDate.toISOString(),
    publishDateDisplay: publishDateFormatter.format(publishDate),
    author,
  };
}

const BASE_URL =
  typeof import.meta.env !== "undefined" && import.meta.env.MODE === "development"
    ? "http://localhost:3000"
    : "https://fragno.dev";

export function meta({ data }: Route.MetaArgs) {
  if (!data) {
    return [{ title: "Not Found" }];
  }

  const ogImage = `${BASE_URL}/og/${data.slug}-og.webp`;
  const twitterImage = `${BASE_URL}/og/${data.slug}-twitter.webp`;

  return [
    { title: `${data.title} | Fragno Blog` },
    { name: "description", content: data.description },
    { property: "og:title", content: data.title },
    { property: "og:description", content: data.description },
    { property: "og:type", content: "article" },
    { property: "og:published_time", content: data.publishDateIso },
    { property: "og:authors", content: data.author ? [data.author] : undefined },
    { property: "og:image", content: ogImage },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: data.title },
    { name: "twitter:description", content: data.description },
    { name: "twitter:image", content: twitterImage },
  ];
}

type TocItem = {
  url?: string;
  title?: string;
  text?: string;
  depth?: number;
  items?: TocItem[];
};

const publishDateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

function getAuthorXUrl(author?: string) {
  if (!author) {
    return null;
  }

  const normalized = author.toLowerCase();
  if (normalized.includes("wilco")) {
    return "https://x.com/wilcokr";
  }
  if (normalized.includes("jan")) {
    return "https://x.com/jan_schutte";
  }

  return null;
}

function getTocIndentClass(depth: number) {
  switch (depth) {
    case 1:
    case 2:
      return "";
    case 3:
      return "pl-4";
    case 4:
      return "pl-8";
    default:
      return "pl-12";
  }
}

function TableOfContents({ items }: { items: TocItem[] }) {
  const renderItems = (nodes: TocItem[]) => {
    if (nodes.length === 0) {
      return null;
    }

    return (
      <ul className="space-y-2">
        {nodes.map((node) => {
          const label = node.title ?? node.text ?? "";
          const href = node.url ?? "";
          const depth = node.depth ?? 2;

          return (
            <li key={`${href}${label}`} className={getTocIndentClass(depth)}>
              <a
                href={href}
                className={cn(
                  "block text-base leading-snug text-[var(--editorial-muted)] transition-colors hover:text-[var(--editorial-secondary)]",
                )}
              >
                {label}
              </a>
              {node.items && node.items.length > 0 ? renderItems(node.items) : null}
            </li>
          );
        })}
      </ul>
    );
  };

  return <nav aria-label="Table of contents">{renderItems(items)}</nav>;
}

function ShareControls({ url, author }: { url: string; author?: string }) {
  const [shareUrl, setShareUrl] = useState("");
  const authorXUrl = getAuthorXUrl(author);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    setShareUrl(`${window.location.origin}${url}`);
  }, [url]);

  const [isChecked, onCopy] = useCopyButton(() => {
    if (shareUrl === "") {
      return;
    }

    void navigator.clipboard.writeText(shareUrl);
  });

  return (
    <div className="space-y-3">
      {authorXUrl ? (
        <a
          href={authorXUrl}
          target="_blank"
          rel="noreferrer"
          className={cn(
            "inline-flex w-full items-center justify-center px-4 py-3 text-base font-bold uppercase tracking-[0.14em] text-[var(--editorial-ink)] shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-surface)_70%,transparent)]",
          )}
        >
          Follow {author}
        </a>
      ) : null}

      <button
        type="button"
        className={cn(
          "inline-flex w-full items-center justify-center gap-2 px-4 py-3 text-base font-bold uppercase tracking-[0.14em] text-[var(--editorial-ink)] shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-surface)_70%,transparent)]",
          isChecked && "bg-[color-mix(in_srgb,var(--editorial-surface)_70%,transparent)]",
        )}
        onClick={onCopy}
      >
        {isChecked ? (
          <>
            <Check className="size-4" />
            Link copied
          </>
        ) : (
          <>Copy article link</>
        )}
      </button>
    </div>
  );
}

const clientLoader = browserCollections.blog.createClientLoader<Record<string, never>>({
  component({ toc, default: Mdx, frontmatter }) {
    const publishDateSource = frontmatter.date;
    if (!publishDateSource) {
      throw new Error("Missing publish date for blog post");
    }

    const publishDate = new Date(publishDateSource);
    if (Number.isNaN(publishDate.getTime())) {
      throw new Error("Invalid publish date for blog post");
    }

    const publishDateIso = publishDate.toISOString();
    const publishDateDisplay = publishDateFormatter.format(publishDate);

    const [postUrl, setPostUrl] = useState("");
    useEffect(() => {
      if (typeof window === "undefined") {
        return;
      }
      setPostUrl(window.location.pathname);
    }, []);

    return (
      <LevelProvider>
        <main className="relative mx-auto w-full max-w-7xl px-4 pt-10 pb-16 sm:px-6 md:pt-16 md:pb-24 lg:px-8">
          <article className="mx-auto w-full max-w-5xl">
            <Link
              to="/blog"
              className={cn(
                "mb-8 inline-flex items-center gap-2 text-base uppercase tracking-[0.16em] text-[var(--editorial-muted)] transition-colors hover:text-[var(--editorial-secondary)]",
              )}
            >
              <ArrowLeft className="size-4" />
              Back to blog
            </Link>

            <header className="max-w-4xl space-y-6 pb-10 md:pb-14">
              <div className={eyebrow}>Fragno Blog</div>
              <h1 className="max-w-4xl text-5xl leading-[0.96] font-bold tracking-[-0.045em] md:text-7xl">
                {frontmatter.title}
              </h1>
              {frontmatter.description ? (
                <p className={`${prose} max-w-2xl`}>{frontmatter.description}</p>
              ) : null}
              <div className={metaText}>
                <time dateTime={publishDateIso}>{publishDateDisplay}</time>
                {frontmatter.author ? <span> — {frontmatter.author}</span> : null}
              </div>
            </header>

            <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-start">
              <div className={articleContentClass}>
                <Mdx
                  components={getMDXComponents({
                    a: (props: ComponentPropsWithoutRef<"a">) => {
                      const { className, ...rest } = props;
                      return (
                        <a
                          {...rest}
                          className={cn(
                            "text-[var(--editorial-secondary)] transition-colors hover:opacity-80 focus:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--editorial-secondary)_28%,transparent)]",
                            className,
                          )}
                        />
                      );
                    },
                  })}
                />
              </div>

              <aside className="space-y-4 lg:sticky lg:top-24">
                {toc.length > 0 ? (
                  <div className={panelClass}>
                    <div className={panelTitle}>Table of contents</div>
                    <div className="max-h-[40vh] overflow-y-auto pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      <TableOfContents items={toc as unknown as TocItem[]} />
                    </div>
                  </div>
                ) : null}

                <div className={panelClass}>
                  <div className={panelTitle}>Share</div>
                  <ShareControls url={postUrl} author={frontmatter.author} />
                </div>
              </aside>
            </div>
          </article>
        </main>
      </LevelProvider>
    );
  },
});

export default function BlogPostPage({ loaderData }: Route.ComponentProps) {
  const { path } = loaderData;
  const Content = clientLoader.getComponent(path);

  return <Content />;
}
