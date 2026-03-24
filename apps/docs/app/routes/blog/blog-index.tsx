import { Link } from "react-router";

import { blogSource } from "@/lib/source";

import type { Route } from "./+types/blog-index";

const mono =
  'font-mono [font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation_Mono",monospace]';
const prose = `${mono} text-base leading-[1.8] text-[var(--editorial-muted)]`;

export function meta() {
  return [
    { title: "Fragno Blog" },
    { name: "description", content: "Keep up with the Fragno ecosystem." },
  ];
}

export async function loader() {
  const posts = [...blogSource.getPages()]
    .map((post) => ({
      url: post.url,
      title: post.data.title,
      description: post.data.description,
      date: "date" in post.data ? post.data.date : new Date(),
      author: "author" in post.data ? post.data.author : undefined,
    }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return { posts };
}

export default function BlogPage({ loaderData }: Route.ComponentProps) {
  const { posts } = loaderData;

  return (
    <main className="relative mx-auto w-full max-w-7xl px-4 pt-12 pb-16 sm:px-6 md:pt-18 md:pb-24 lg:px-8">
      <div className="mx-auto w-full max-w-5xl space-y-12">
        <header className="max-w-4xl space-y-6">
          <div
            className={`${mono} text-base font-bold tracking-[0.14em] text-[var(--editorial-primary)] uppercase`}
          >
            Archive // Fragno Journal
          </div>
          <h1 className="max-w-3xl text-5xl leading-[0.96] font-bold tracking-[-0.045em] md:text-7xl">
            Technical notes, releases, and field reports.
          </h1>
          <p className={`${prose} max-w-2xl`}>
            Essays and updates on fragments, framework integrations, workflows, and the broader
            Fragno ecosystem.
          </p>
        </header>

        {posts.length === 0 ? (
          <section className="overflow-hidden bg-[color-mix(in_srgb,var(--editorial-surface)_84%,transparent)] p-8 shadow-[0_24px_48px_rgb(15_23_42_/_0.08)] backdrop-blur-[12px] md:p-10 dark:shadow-[0_24px_48px_rgb(2_6_23_/_0.28)]">
            <p className={prose}>No entries yet. Check back soon.</p>
          </section>
        ) : (
          <section className="grid gap-4 md:gap-6">
            {posts.map((post, index) => (
              <article
                key={post.url}
                className="grid gap-6 bg-[color-mix(in_srgb,var(--editorial-surface)_88%,transparent)] p-6 shadow-[0_12px_28px_rgb(15_23_42_/_0.05)] md:grid-cols-[auto_1fr_auto] md:items-start dark:shadow-[0_12px_28px_rgb(2_6_23_/_0.2)]"
              >
                <div
                  className={`${mono} pt-1 text-base font-bold tracking-[0.18em] text-[var(--editorial-primary)] uppercase`}
                >
                  {String(index + 1).padStart(2, "0")}
                </div>
                <div className="space-y-3">
                  <div
                    className={`${mono} text-base tracking-[0.15em] text-[var(--editorial-muted)] uppercase`}
                  >
                    <time dateTime={new Date(post.date).toISOString()}>
                      {new Date(post.date).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })}
                    </time>
                    {post.author ? <span>— {post.author}</span> : null}
                  </div>
                  <h2 className="text-2xl font-bold tracking-tight md:text-3xl">
                    <Link
                      to={post.url}
                      className="transition-colors hover:text-[var(--editorial-primary)]"
                    >
                      {post.title}
                    </Link>
                  </h2>
                  <p className={prose}>{post.description}</p>
                </div>
                <div className="md:text-right">
                  <Link
                    to={post.url}
                    className="text-[var(--editorial-secondary)] transition-colors hover:opacity-80"
                  >
                    Read article →
                  </Link>
                </div>
              </article>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
