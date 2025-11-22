import Link from "next/link";
import Image from "next/image";
import { blogSource } from "@/lib/source";
import { Calendar, User, ArrowRight } from "lucide-react";

export default function Page() {
  const posts = [...blogSource.getPages()].sort(
    (a, b) =>
      new Date(b.data.date ?? b.file.name).getTime() -
      new Date(a.data.date ?? a.file.name).getTime(),
  );

  return (
    <main className="min-h-screen bg-gradient-to-br from-zinc-50 via-white to-stone-50 dark:from-zinc-950 dark:via-zinc-900 dark:to-stone-950">
      {/* Hero Section */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-zinc-500/15 via-neutral-500/15 to-stone-500/15 dark:from-zinc-400/10 dark:via-neutral-400/10 dark:to-stone-400/10" />
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

        <div className="relative mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
          <div className="text-center">
            <h1 className="text-5xl font-bold tracking-tight text-gray-900 sm:text-6xl lg:text-7xl dark:text-white">
              <span className="bg-gradient-to-r from-gray-900 via-zinc-800 to-stone-700 bg-clip-text text-transparent dark:from-gray-100 dark:via-zinc-300 dark:to-stone-400">
                Fragno Blog
              </span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-xl text-gray-600 dark:text-gray-300">
              Keep up with the Fragno ecosystem.
            </p>
            <div className="mt-8 flex justify-center">
              <div className="inline-flex items-center gap-2 rounded-full bg-white/80 px-4 py-2 text-sm font-medium text-gray-700 shadow-lg backdrop-blur-sm dark:bg-gray-800/80 dark:text-gray-200">
                <div className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
                {posts.length} {posts.length === 1 ? "article" : "articles"} published
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Blog Posts Grid */}
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
          {posts.map((post, index) => (
            <article
              key={post.url}
              className="group relative overflow-hidden rounded-2xl bg-white shadow-lg transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl dark:bg-gray-800"
              style={{
                animationDelay: `${index * 100}ms`,
              }}
            >
              {/* Card Background Gradient */}
              <div className="absolute inset-0 bg-gradient-to-br from-zinc-50 via-gray-50 to-stone-50 opacity-0 transition-opacity duration-300 group-hover:opacity-100 dark:from-zinc-900/20 dark:via-gray-900/20 dark:to-stone-900/20" />

              <Link href={post.url} className="relative block h-full">
                {/* Hero Image or Decorative Gradient */}
                {post.data.image ? (
                  <div className="relative h-48 w-full overflow-hidden">
                    <Image
                      src={`/${post.data.image}`}
                      alt={post.data.title}
                      fill
                      className="object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  </div>
                ) : (
                  <div className="relative h-48 w-full overflow-hidden bg-gradient-to-br from-zinc-100 via-gray-100 to-stone-100 dark:from-zinc-800 dark:via-gray-800 dark:to-stone-800">
                    <div
                      className="absolute inset-0 opacity-30"
                      style={{
                        backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%239C92AC' fill-opacity='0.15'%3E%3Ccircle cx='30' cy='30' r='2'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
                      }}
                    />
                  </div>
                )}

                <div className="p-8">
                  {/* Post Meta */}
                  <div className="mb-4 flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
                    <div className="flex items-center gap-1">
                      <Calendar className="h-4 w-4" />
                      <time dateTime={new Date(post.data.date ?? post.file.name).toISOString()}>
                        {new Date(post.data.date ?? post.file.name).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </time>
                    </div>
                    {post.data.author && (
                      <div className="flex items-center gap-1">
                        <User className="h-4 w-4" />
                        <span>{post.data.author}</span>
                      </div>
                    )}
                  </div>

                  {/* Post Title */}
                  <h2 className="mb-3 text-xl font-bold text-gray-900 transition-colors group-hover:text-gray-950 dark:text-white dark:group-hover:text-white">
                    {post.data.title}
                  </h2>

                  {/* Post Description */}
                  <p className="mb-6 line-clamp-3 text-gray-600 dark:text-gray-300">
                    {post.data.description}
                  </p>

                  {/* Read More */}
                  <div className="flex items-center text-sm font-medium text-gray-700 transition-colors group-hover:text-gray-900 dark:text-gray-300 dark:group-hover:text-gray-100">
                    <span>Read article</span>
                    <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </div>
                </div>
              </Link>
            </article>
          ))}
        </div>

        {/* Empty State */}
        {posts.length === 0 && (
          <div className="py-16 text-center">
            <div className="mx-auto mb-4 flex h-24 w-24 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
              <svg
                className="h-12 w-12 text-gray-400"
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
            <h3 className="mb-2 text-lg font-medium text-gray-900 dark:text-white">
              No articles yet
            </h3>
            <p className="text-gray-500 dark:text-gray-400">Check back soon for new content!</p>
          </div>
        )}
      </div>
    </main>
  );
}
