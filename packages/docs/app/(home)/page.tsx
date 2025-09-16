import Link from "next/link";
import { FragnoLogo } from "@/components/logos/fragno-logo";
import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col items-center px-4 py-16">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="mx-auto mt-[-80px] h-[520px] w-[820px] rounded-full bg-gradient-to-br from-blue-500/25 via-sky-400/20 to-purple-500/20 opacity-20 blur-3xl dark:opacity-40" />
      </div>

      <section className="w-full max-w-5xl space-y-6 text-center">
        <div className="flex justify-center">
          <FragnoLogo className="size-72 dark:text-white" />
        </div>

        <h1 className="text-fd-foreground text-5xl font-extrabold tracking-tight md:text-7xl dark:bg-gradient-to-b dark:from-white dark:to-white/70 dark:bg-clip-text dark:text-transparent">
          <span>
            <span className="underline decoration-blue-600 underline-offset-4 dark:decoration-blue-400">
              Fr
            </span>
            amework-
            <span className="underline decoration-purple-600 underline-offset-4 dark:decoration-purple-400">
              agno
            </span>
            stic
          </span>{" "}
          TypeScript libraries
        </h1>
        <p className="text-fd-muted-foreground mx-auto max-w-3xl text-lg md:text-2xl">
          Full-stack libraries, compatible with all major frameworks. Front-end state management
          included.
        </p>

        <div className="flex flex-col items-center justify-center gap-3 pt-2 sm:flex-row">
          <Link
            href="/docs"
            className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
          >
            Get Started
          </Link>
          <Link
            href="/docs"
            className="border-fd-border hover:bg-fd-accent/60 text-fd-foreground rounded-lg border px-6 py-3 font-semibold transition-colors"
          >
            View Docs
          </Link>
        </div>
      </section>

      <section className="mt-14 grid w-full max-w-5xl gap-6 md:grid-cols-3">
        <div className="border-fd-border bg-fd-card/50 hover:bg-fd-accent/40 rounded-xl border p-5 transition-colors">
          <h3 className="mb-1 text-lg font-semibold">🔐 End-to-end type safety</h3>
          <p className="text-fd-muted-foreground">From server to client, everything is typed.</p>
        </div>
        <div className="border-fd-border bg-fd-card/50 hover:bg-fd-accent/40 rounded-xl border p-5 transition-colors">
          <h3 className="mb-1 text-lg font-semibold">🎯 Framework agnostic</h3>
          <p className="text-fd-muted-foreground">
            Works with React, Vue, Next.js, Nuxt, React Router.
          </p>
        </div>
        <div className="border-fd-border bg-fd-card/50 hover:bg-fd-accent/40 rounded-xl border p-5 transition-colors">
          <h3 className="mb-1 text-lg font-semibold">📦 Automatic code splitting</h3>
          <p className="text-fd-muted-foreground">Server code never reaches the client bundle.</p>
        </div>
        <div className="border-fd-border bg-fd-card/50 hover:bg-fd-accent/40 rounded-xl border p-5 transition-colors">
          <h3 className="mb-1 text-lg font-semibold">🚀 Built-in state management</h3>
          <p className="text-fd-muted-foreground">Reactive stores with caching built in.</p>
        </div>
        <div className="border-fd-border bg-fd-card/50 hover:bg-fd-accent/40 rounded-xl border p-5 transition-colors">
          <h3 className="mb-1 text-lg font-semibold">🌊 Streaming support</h3>
          <p className="text-fd-muted-foreground">Real-time NDJSON streaming for live data.</p>
        </div>
        <div className="border-fd-border bg-fd-card/50 hover:bg-fd-accent/40 rounded-xl border p-5 transition-colors">
          <h3 className="mb-1 text-lg font-semibold">🔄 Middleware support</h3>
          <p className="text-fd-muted-foreground">Compose auth and custom request processing.</p>
        </div>
      </section>

      <section className="mt-16 w-full max-w-5xl">
        <div className="border-fd-border bg-fd-card rounded-xl border p-1">
          <div className="rounded-[10px] bg-gradient-to-b from-black/5 to-transparent p-6 dark:from-white/5">
            <div className="text-fd-muted-foreground mb-4 flex items-center gap-2 text-xs">
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-red-500/80" />
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-yellow-500/80" />
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-green-500/80" />
              <span className="ml-auto">TypeScript</span>
            </div>
            <DynamicCodeBlock
              lang="ts"
              code={`import { defineLibrary, defineRoute, createLibrary } from "@fragno-dev/core";

const getTodosRoute = defineRoute({
  method: "GET",
  path: "/todos",
  outputSchema: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      done: z.boolean(),
    }),
  ),
  handler: async (_, { json }) => {
    return json([]);
  },
});`}
            />
          </div>
        </div>
      </section>
    </main>
  );
}
