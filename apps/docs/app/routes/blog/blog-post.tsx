import type { Route } from "./+types/blog-post";
import { Link } from "react-router";
import { blogSource } from "@/lib/source";
import { cn } from "@/lib/cn";
import { ArrowLeft, Calendar, User, Check, Link as LinkIcon } from "lucide-react";
import { LevelProvider } from "@/components/levels-context";
import { LevelSlider } from "@/components/level-slider";
import { useEffect, useMemo, useState } from "react";
import { useCopyButton } from "fumadocs-ui/utils/use-copy-button";
import { TwitterXLogo } from "@/components/logos/twitter-x";
import type { ComponentPropsWithoutRef } from "react";
import browserCollections from "fumadocs-mdx:collections/browser";
import { getMDXComponents } from "@/lib/mdx-components";

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
  const publishDateIso = publishDate.toISOString();
  const publishDateDisplay = publishDateFormatter.format(publishDate);

  const enableLevels = "_exports" in page.data && page.data._exports?.enableLevels === true;
  const author = "author" in page.data ? page.data.author : undefined;

  return {
    slug: params.slug,
    path: page.path,
    url: page.url,
    title: page.data.title,
    description: page.data.description ?? "The library for building documentation sites",
    publishDateIso,
    publishDateDisplay,
    enableLevels,
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

function CustomTOC({ items }: { items: TocItem[] }) {
  const getIndentClass = (depth: number) => {
    switch (depth) {
      case 1:
        return "-pl-4"; // We don't typically use h1
      case 2:
        return "";
      case 3:
        return "pl-4";
      case 4:
        return "pl-8";
      case 5:
        return "pl-12";
      case 6:
        return "pl-16";
      default:
        return "pl-16";
    }
  };

  const renderItems = (nodes: TocItem[]) => {
    if (!nodes || nodes.length === 0) {
      return null;
    }

    return (
      <ul className="space-y-1">
        {nodes.map((node) => {
          const label = node.title ?? node.text ?? "";
          const href = node.url ?? "";
          const depth = node.depth ?? 1;
          const indentClass = getIndentClass(depth);

          return (
            <li key={`${href}${label}`}>
              <a
                href={href}
                className={`group relative inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white ${indentClass}`}
              >
                <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center">
                  <span className="absolute inset-0 rounded-sm border border-gray-300 dark:border-gray-600" />
                  <span className="h-2 w-2 rotate-45 rounded-sm bg-gray-300 transition-colors group-hover:bg-gray-900 dark:bg-gray-600 dark:group-hover:bg-white" />
                </span>
                <span className="whitespace-normal break-words leading-snug">{label}</span>
              </a>
              {node.items && node.items.length > 0 ? renderItems(node.items) : null}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <nav aria-label="Table of contents" className="space-y-1">
      {renderItems(items)}
    </nav>
  );
}

function Control({ url, author }: { url: string; author?: string }) {
  const [shareUrl, setShareUrl] = useState("");
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

  const authorXUrl = useMemo(() => {
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
  }, [author]);

  return (
    <div className="space-y-4">
      {authorXUrl ? (
        <a
          href={authorXUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 transition-all duration-200 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-700/50 dark:hover:text-gray-100",
          )}
        >
          <TwitterXLogo className="size-4" />
          Follow
        </a>
      ) : null}
      {/* Copy Link Button */}
      <button
        type="button"
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 transition-all duration-200 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-700",
          isChecked &&
            "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400",
        )}
        onClick={onCopy}
      >
        {isChecked ? (
          <>
            <Check className="size-4" />
            Link ready to share
          </>
        ) : (
          <>
            <LinkIcon className="size-4" />
            Copy Article Link
          </>
        )}
      </button>
    </div>
  );
}

const clientLoader = browserCollections.blog.createClientLoader({
  component({ toc, default: Mdx, frontmatter }) {
    const publishDateSource = frontmatter.date;
    if (!publishDateSource) {
      throw new Error(`Missing publish date for blog post`);
    }
    const publishDate = new Date(publishDateSource);
    if (Number.isNaN(publishDate.getTime())) {
      throw new Error(`Invalid publish date for blog post`);
    }
    const publishDateIso = publishDate.toISOString();
    const publishDateDisplay = publishDateFormatter.format(publishDate);

    const enableLevels = false;

    const [postUrl, setPostUrl] = useState("");
    useEffect(() => {
      setPostUrl(window.location.pathname);
    }, []);

    return (
      <LevelProvider>
        <div className="min-h-screen bg-gradient-to-br from-zinc-50 via-white to-stone-50 dark:from-zinc-950 dark:via-zinc-900 dark:to-stone-950">
          {/* Hero Section */}
          <div className="relative mb-4 overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-zinc-500/10 via-neutral-500/10 to-stone-500/10 dark:from-zinc-400/5 dark:via-neutral-400/5 dark:to-stone-400/5" />
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%239C92AC' fill-opacity='0.1'%3E%3Ccircle cx='30' cy='30' r='2'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
              }}
            />
            <div
              className="pointer-events-none absolute inset-0 opacity-20 mix-blend-multiply dark:opacity-10"
              style={{
                backgroundImage:
                  "linear-gradient(120deg, rgba(0,0,0,0.05) 25%, transparent 25%, transparent 50%, rgba(0,0,0,0.05) 50%, rgba(0,0,0,0.05) 75%, transparent 75%, transparent)",
                backgroundSize: "24px 24px",
              }}
            />
            <div className="pointer-events-none absolute -right-8 top-8 h-24 w-24 rotate-12 rounded-xl border border-gray-300/60 dark:border-white/10" />

            <div className="relative mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
              <Link
                to="/blog"
                className="group mb-8 inline-flex items-center gap-2 text-sm font-medium text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
              >
                <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
                Back to blog
              </Link>

              <header className="mb-10">
                <h1 className="mb-5 max-w-prose text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl lg:text-6xl dark:text-white">
                  {frontmatter.title}
                </h1>

                {frontmatter.description && (
                  <p className="mb-6 max-w-prose text-xl leading-relaxed text-gray-600 dark:text-gray-300">
                    {frontmatter.description}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-5 text-sm text-gray-500 dark:text-gray-400">
                  <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4" />
                    <time dateTime={publishDateIso}>{publishDateDisplay}</time>
                  </div>

                  {frontmatter.author && (
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4" />
                      <span>{frontmatter.author}</span>
                    </div>
                  )}
                </div>
              </header>
            </div>
          </div>

          {/* Article Content */}
          <article className="mx-auto max-w-6xl px-4 pb-16 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_320px] xl:grid-cols-[1fr_360px]">
              {/* Main Content */}
              <div className="min-w-0 flex-1">
                {enableLevels && <LevelSlider />}
                <div className="prose prose-lg dark:prose-invert prose-headings:font-bold prose-headings:tracking-tight prose-h1:text-3xl prose-h2:text-2xl prose-h3:text-xl prose-a:text-gray-900 prose-a:no-underline dark:prose-a:text-gray-100 prose-pre:bg-gray-900 prose-pre:text-gray-100 dark:prose-pre:bg-gray-800 dark:prose-pre:text-gray-200 prose-code:bg-gray-100 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm dark:prose-code:bg-gray-800 max-w-none">
                  <Mdx
                    components={getMDXComponents({
                      a: (props: ComponentPropsWithoutRef<"a">) => {
                        const { className, ...rest } = props;
                        return (
                          <a
                            {...rest}
                            className={cn(
                              "rounded-sm no-underline decoration-gray-300 underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 dark:decoration-gray-600 dark:focus-visible:ring-gray-700",
                              className,
                            )}
                          />
                        );
                      },
                    })}
                  />
                </div>
              </div>

              {/* Sidebar */}
              <aside className="lg:w-auto">
                <div className="sticky top-16 space-y-6">
                  {/* Table of Contents */}
                  {toc.length > 0 && (
                    <div className="card-shell relative overflow-hidden rounded-2xl border border-black/5 bg-white/70 p-6 shadow-sm backdrop-blur dark:border-white/10 dark:bg-gray-900/40">
                      <div className="pointer-events-none absolute right-4 top-4 h-6 w-6 rotate-45 border border-gray-200/60 dark:border-white/10" />
                      <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-200">
                        Table of contents
                      </h3>
                      <div className="max-h-[40vh] overflow-y-auto pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {/* The content source TOC matches TocItem shape */}
                        <CustomTOC items={toc as unknown as TocItem[]} />
                      </div>
                    </div>
                  )}

                  {frontmatter.author ? (
                    <div className="relative overflow-hidden rounded-2xl border border-black/5 bg-white/80 p-6 shadow-sm backdrop-blur dark:border-white/10 dark:bg-gray-800/60">
                      <div className="pointer-events-none absolute -left-6 -top-6 h-16 w-16 rounded-full border border-gray-200/60 dark:border-white/10" />
                      <div className="pointer-events-none absolute bottom-0 right-6 h-10 w-10 rotate-12 border-b border-r border-gray-200/60 dark:border-white/10" />
                      <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-900 dark:text-white">
                        Stay connected
                      </h3>
                      <div className="mb-4 flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-gray-300 bg-white text-sm font-semibold text-gray-700 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                          {frontmatter.author
                            .split(" ")
                            .map((part) => part.charAt(0).toUpperCase())
                            .join("")}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900 dark:text-white">
                            {frontmatter.author}
                          </p>
                          <p className="text-xs text-gray-600 dark:text-gray-400">Fragno Team</p>
                        </div>
                      </div>
                      <Control url={postUrl} author={frontmatter.author} />
                    </div>
                  ) : (
                    <div className="relative overflow-hidden rounded-2xl border border-black/5 bg-white/80 p-6 shadow-sm backdrop-blur dark:border-white/10 dark:bg-gray-800/60">
                      <div className="pointer-events-none absolute -left-6 -top-6 h-16 w-16 rounded-full border border-gray-200/60 dark:border-white/10" />
                      <div className="pointer-events-none absolute bottom-0 right-6 h-10 w-10 rotate-12 border-b border-r border-gray-200/60 dark:border-white/10" />
                      <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-900 dark:text-white">
                        Share
                      </h3>
                      <Control url={postUrl} />
                    </div>
                  )}
                </div>
              </aside>
            </div>
          </article>
        </div>
      </LevelProvider>
    );
  },
});

export default function BlogPostPage({ loaderData }: Route.ComponentProps) {
  const { path } = loaderData;
  const Content = clientLoader.getComponent(path);

  return <Content />;
}
