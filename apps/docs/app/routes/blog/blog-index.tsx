import type { Route } from "./+types/blog-index";
import { Link } from "react-router";
import { blogSource } from "@/lib/source";
import { Calendar, User, ArrowRight } from "lucide-react";

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
      image: "image" in post.data ? post.data.image : undefined,
    }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return { posts };
}

export default function BlogPage({ loaderData }: Route.ComponentProps) {
  const { posts } = loaderData;

  return (
    <main className="container flex min-h-screen flex-1 flex-col items-center py-12">
      <div className="w-full max-w-6xl">
        <header className="relative mb-10 overflow-hidden rounded-3xl border border-black/5 bg-white/70 px-6 py-10 shadow-sm backdrop-blur sm:px-10 dark:border-white/10 dark:bg-slate-950/50">
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
            <div className="bg-linear-to-br absolute -left-12 -top-16 h-48 w-72 rounded-full from-blue-500/15 via-sky-400/10 to-transparent blur-3xl" />
            <div className="bg-linear-to-br from-purple-500/14 absolute -bottom-24 -right-16 h-56 w-72 rounded-full via-fuchsia-400/10 to-transparent blur-3xl" />
          </div>

          <p className="text-fd-muted-foreground text-sm font-medium">News & updates</p>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight md:text-5xl">Fragno Blog</h1>
          <p className="text-fd-muted-foreground mt-3 max-w-2xl text-lg">
            Keep up with the Fragno ecosystem.
          </p>
        </header>

        {posts.length === 0 ? (
          <div className="mx-auto max-w-2xl">
            <div className="rounded-2xl bg-white/90 p-10 text-center shadow-sm ring-1 ring-black/5 dark:bg-slate-950/60 dark:ring-white/10">
              <div className="bg-fd-border mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-2xl">
                <svg
                  className="text-fd-muted-foreground h-10 w-10"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"
                  />
                </svg>
              </div>
              <h2 className="text-fd-foreground text-xl font-semibold">No articles yet</h2>
              <p className="text-fd-muted-foreground mt-2">Check back soon for new content.</p>
            </div>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => (
              <article key={post.url}>
                <Link
                  to={post.url}
                  className="group relative block h-full overflow-hidden rounded-2xl bg-white/90 shadow-sm ring-1 ring-black/5 transition-all hover:-translate-y-1 hover:shadow-xl dark:bg-slate-950/60 dark:ring-white/10"
                >
                  <span className="absolute inset-x-6 -top-16 h-28 rounded-full bg-blue-600/10 opacity-0 blur-3xl transition-opacity group-hover:opacity-80 dark:bg-blue-600/15" />

                  <div className="relative">
                    {post.image ? (
                      <div className="relative aspect-[16/9] w-full overflow-hidden">
                        <img
                          src={`/${post.image}`}
                          alt={post.title}
                          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                        />
                        <div
                          aria-hidden
                          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-black/0 to-black/0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                        />
                      </div>
                    ) : (
                      <div className="bg-linear-to-br relative aspect-[16/9] w-full overflow-hidden from-blue-500/10 via-transparent to-purple-500/10 dark:from-blue-500/15 dark:to-purple-500/15">
                        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(59,130,246,0.18),transparent_55%)]" />
                        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_80%_30%,rgba(168,85,247,0.14),transparent_55%)]" />
                      </div>
                    )}

                    <div className="p-6">
                      <div className="text-fd-muted-foreground mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                        <div className="inline-flex items-center gap-1.5">
                          <Calendar className="size-4 opacity-70" />
                          <time dateTime={new Date(post.date).toISOString()}>
                            {new Date(post.date).toLocaleDateString("en-US", {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })}
                          </time>
                        </div>

                        {post.author ? (
                          <div className="inline-flex items-center gap-1.5">
                            <User className="size-4 opacity-70" />
                            <span>{post.author}</span>
                          </div>
                        ) : null}
                      </div>

                      <h2 className="text-fd-foreground mb-2 line-clamp-2 text-xl font-semibold tracking-tight">
                        {post.title}
                      </h2>

                      <p className="text-fd-muted-foreground mb-4 line-clamp-3 text-sm leading-relaxed">
                        {post.description}
                      </p>

                      <div className="inline-flex items-center gap-2 text-sm font-medium text-blue-700 transition-colors group-hover:text-blue-800 dark:text-blue-400 dark:group-hover:text-blue-300">
                        <span>Read article</span>
                        <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                      </div>
                    </div>
                  </div>
                </Link>
              </article>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
