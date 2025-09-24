import type { Metadata } from "next";
import type { ComponentPropsWithoutRef } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { blogSource } from "@/lib/source";
import { Control } from "@/app/(home)/blog/[slug]/page.client";
import { getMDXComponents } from "@/mdx-components";
import { cn } from "@/lib/cn";
import { ArrowLeft, Calendar, User } from "lucide-react";
import path from "node:path";

type TocItem = {
  url?: string;
  title?: string;
  text?: string;
  depth?: number;
  items?: TocItem[];
};

function CustomTOC({ items }: { items: TocItem[] }) {
  const renderItems = (nodes: TocItem[], level = 0) => {
    if (!nodes || nodes.length === 0) {
      return null;
    }
    const listClass =
      (level > 0 ? "mt-2 pl-3 border-l border-gray-200 dark:border-gray-700 " : "") + "space-y-1";
    return (
      <ul className={listClass}>
        {nodes.map((node) => {
          const label = node.title ?? node.text ?? "";
          const href = node.url ?? "";
          return (
            <li key={`${href}${label}`}>
              <a
                href={href}
                className="group relative inline-flex items-start gap-2 rounded-md px-2 py-1.5 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
              >
                <span className="relative grid h-3 w-3 place-items-center">
                  <span className="absolute inset-0 rounded-sm border border-gray-300 dark:border-gray-600" />
                  <span className="h-1 w-1 rotate-45 rounded-sm bg-gray-300 transition-colors group-hover:bg-gray-900 dark:bg-gray-600 dark:group-hover:bg-white" />
                </span>
                <span className="whitespace-normal break-words leading-snug">{label}</span>
              </a>
              {node.items && node.items.length > 0 ? renderItems(node.items, level + 1) : null}
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

export default async function Page(props: PageProps<"/blog/[slug]">) {
  const params = await props.params;
  const page = blogSource.getPage([params.slug]);

  if (!page) notFound();
  const { body: Mdx, toc } = page.data;

  const publishDate = new Date(page.data.date ?? path.basename(page.path, path.extname(page.path)));

  return (
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
        {/* Subtle diagonal stripes */}
        <div
          className="pointer-events-none absolute inset-0 opacity-20 mix-blend-multiply dark:opacity-10"
          style={{
            backgroundImage:
              "linear-gradient(120deg, rgba(0,0,0,0.05) 25%, transparent 25%, transparent 50%, rgba(0,0,0,0.05) 50%, rgba(0,0,0,0.05) 75%, transparent 75%, transparent)",
            backgroundSize: "24px 24px",
          }}
        />
        {/* Geometric accents */}
        <div className="pointer-events-none absolute -right-8 top-8 h-24 w-24 rotate-12 rounded-xl border border-gray-300/60 dark:border-white/10" />

        <div className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
          {/* Back Button */}
          <Link
            href="/blog"
            className="group mb-8 inline-flex items-center gap-2 text-sm font-medium text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
          >
            <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
            Back to blog
          </Link>

          {/* Article Header */}
          <header className="mb-12">
            <h1 className="mb-6 text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl lg:text-6xl dark:text-white">
              {page.data.title}
            </h1>

            {page.data.description && (
              <p className="mb-8 text-xl leading-relaxed text-gray-600 dark:text-gray-300">
                {page.data.description}
              </p>
            )}

            {/* Article Meta */}
            <div className="flex flex-wrap items-center gap-6 text-sm text-gray-500 dark:text-gray-400">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                <time dateTime={publishDate.toISOString()}>
                  {publishDate.toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </time>
              </div>

              {page.data.author && (
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4" />
                  <span>{page.data.author}</span>
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
            <div className="sticky top-8 space-y-6">
              {/* Table of Contents */}
              {toc.length > 0 && (
                <div className="card-shell relative overflow-hidden rounded-2xl border border-black/5 bg-white/70 p-6 shadow-sm backdrop-blur dark:border-white/10 dark:bg-gray-900/40">
                  <div className="pointer-events-none absolute right-4 top-4 h-6 w-6 rotate-45 border border-gray-200/60 dark:border-white/10" />
                  <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-200">
                    Table of contents
                  </h3>
                  {/* The content source TOC matches TocItem shape */}
                  <CustomTOC items={toc as unknown as TocItem[]} />
                </div>
              )}

              {/* Article Actions */}
              <div className="relative overflow-hidden rounded-2xl border border-black/5 bg-white/80 p-6 shadow-sm backdrop-blur dark:border-white/10 dark:bg-gray-800/60">
                <div className="pointer-events-none absolute -left-6 -top-6 h-16 w-16 rounded-full border border-gray-200/60 dark:border-white/10" />
                <div className="pointer-events-none absolute bottom-0 right-6 h-10 w-10 rotate-12 border-b border-r border-gray-200/60 dark:border-white/10" />
                <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-900 dark:text-white">
                  Share
                </h3>
                <Control url={page.url} />
              </div>

              {/* Author Info */}
              {page.data.author && (
                <div className="relative overflow-hidden rounded-2xl border border-black/5 bg-white/80 p-6 shadow-sm backdrop-blur dark:border-white/10 dark:bg-gray-800/60">
                  <div className="pointer-events-none absolute left-4 top-4 h-5 w-5 rotate-12 border border-gray-200/60 dark:border-white/10" />
                  <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-900 dark:text-white">
                    About the author
                  </h3>
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full border border-gray-300 bg-white text-sm font-semibold text-gray-700 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                      {page.data.author.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-medium text-gray-900 dark:text-white">
                        {page.data.author}
                      </p>
                      <p className="text-xs text-gray-600 dark:text-gray-400">Fragno Team</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      </article>
    </div>
  );
}

export async function generateMetadata(props: PageProps<"/blog/[slug]">): Promise<Metadata> {
  const params = await props.params;
  const page = blogSource.getPage([params.slug]);

  if (!page) {
    notFound();
  }

  return {
    title: page.data.title,
    description: page.data.description ?? "The library for building documentation sites",
  };
}

export function generateStaticParams(): { slug: string }[] {
  return blogSource.getPages().map((page) => ({
    slug: page.slugs[0],
  }));
}
