"use client";

import { useState } from "react";
import Link from "next/link";
import { FragnoLogo } from "@/components/logos/fragno-logo";
import { FragnoCodeBlock } from "@/components/fragno-code-block";
import {
  Shield,
  Target,
  Package,
  Rocket,
  Waves,
  RotateCcw,
  Route,
  Database,
  Activity,
  Layers,
  BookOpen,
  Users,
  FileText,
} from "lucide-react";

import BentoCake from "@/components/bento-cake";
import Frameworks from "@/components/frameworks";
import DatabaseIntegration from "@/components/database-integration";
import { GitHub } from "@/components/logos/github";

function Hero() {
  return (
    <section className="w-full max-w-5xl space-y-6 text-center">
      <div className="flex justify-center">
        <FragnoLogo className="size-72 dark:text-white" />
      </div>

      <h1 className="text-fd-foreground text-6xl font-extrabold tracking-tight md:text-7xl dark:bg-gradient-to-b dark:from-white dark:to-white/70 dark:bg-clip-text dark:text-transparent">
        Build Full-
        <span className="text-fd-foreground relative inline-block dark:bg-gradient-to-b dark:from-white dark:to-white/70 dark:bg-clip-text dark:text-transparent">
          Stack
          <span className="absolute -right-3 -top-2 inline-flex rotate-12 items-center md:-right-7 md:-top-3">
            <span className="relative inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-slate-600 via-gray-600 to-zinc-600 px-4 py-1.5 text-white shadow-[0_12px_30px_-12px_rgba(99,102,241,0.65)] ring-1 ring-white/20">
              <span
                aria-hidden
                className="pointer-events-none absolute -inset-0.5 -z-10 rounded-full bg-gradient-to-r from-indigo-500/30 to-fuchsia-500/30 blur-md"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-white/10"
              />

              <span className="select-none text-[11px] font-semibold tracking-wider md:text-xs">
                Developer Beta
              </span>
            </span>
          </span>
        </span>
        <br />
        Libraries
      </h1>
      <p className="text-fd-muted-foreground mx-auto max-w-3xl text-lg md:text-2xl">
        <span>
          Build{" "}
          <span className="underline decoration-blue-600 underline-offset-4 dark:decoration-blue-400">
            fr
          </span>
          amework-
          <span className="underline decoration-purple-600 underline-offset-4 dark:decoration-purple-400">
            agno
          </span>
          stic
        </span>{" "}
        libraries that embed backend and frontend logic in your users' applications
      </p>

      <div className="flex flex-col items-center justify-center gap-3 pt-2 sm:flex-row">
        <Link
          href="/docs/fragno"
          className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
        >
          View Docs
        </Link>
        <Link
          href="https://github.com/rejot-dev/fragno"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg border border-gray-300 px-6 py-3 font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <GitHub className="size-4" />
          Star on GitHub
        </Link>
      </div>
    </section>
  );
}

type FeatureCardProps = {
  icon: React.ReactNode;
  title: string;
  description: string;
  glowClass?: string;
  iconClass?: string;
};

function FeatureCard({
  icon,
  title,
  description,
  glowClass: _glowClass,
  iconClass,
}: FeatureCardProps) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-white/90 p-6 shadow-sm ring-1 ring-black/5 dark:bg-slate-950/60 dark:ring-white/10">
      <div className="relative flex items-start gap-3">
        <span
          className={`flex h-11 w-11 items-center justify-center rounded-xl text-2xl ${iconClass ?? "bg-blue-500/15 dark:bg-blue-400/20"}`}
        >
          {icon}
        </span>
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-fd-muted-foreground mt-1 text-sm">{description}</p>
        </div>
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function Features() {
  return (
    <section className="grid w-full max-w-6xl gap-6 md:grid-cols-3">
      <FeatureCard
        icon={<Shield className="size-6" />}
        title="End-to-end type safety"
        description="From server to client, everything is typed."
        glowClass="bg-blue-500/15 dark:bg-blue-400/20"
        iconClass="bg-blue-500/15 dark:bg-blue-400/20"
      />
      <FeatureCard
        icon={<Target className="size-6" />}
        title="Framework agnostic"
        description="Works with React, Vue, Next.js, Nuxt, React Router."
        glowClass="bg-purple-500/15 dark:bg-purple-400/20"
        iconClass="bg-purple-500/15 dark:bg-purple-400/20"
      />
      <FeatureCard
        icon={<Package className="size-6" />}
        title="Automatic code splitting"
        description="Server code never reaches the client bundle."
        glowClass="bg-rose-500/15 dark:bg-rose-400/20"
        iconClass="bg-rose-500/15 dark:bg-rose-400/20"
      />
      <FeatureCard
        icon={<Rocket className="size-6" />}
        title="Built-in state management"
        description="Reactive stores with caching built in."
        glowClass="bg-emerald-500/15 dark:bg-emerald-400/20"
        iconClass="bg-emerald-500/15 dark:bg-emerald-400/20"
      />
      <FeatureCard
        icon={<Waves className="size-6" />}
        title="Streaming support"
        description="Real-time NDJSON streaming for live data."
        glowClass="bg-sky-500/15 dark:bg-sky-400/20"
        iconClass="bg-sky-500/15 dark:bg-sky-400/20"
      />
      <FeatureCard
        icon={<RotateCcw className="size-6" />}
        title="Middleware support"
        description="Compose auth and custom request processing."
        glowClass="bg-amber-500/15 dark:bg-amber-400/20"
        iconClass="bg-amber-500/15 dark:bg-amber-400/20"
      />
    </section>
  );
}

function WhatFragnoProvides() {
  const providesTabs = [
    {
      id: "server-core",
      label: "Server",
      accent: "from-sky-500/80 via-blue-500/70 to-indigo-500/80",
      code: `import { defineRoute } from "@fragno-dev/core";
import { z } from "zod";

export const route = defineRoute({
  method: "POST",
  path: "/ai-chat",
  inputSchema: z.string(),
  outputSchema: z.array(/* ... */),
  handler: async ({ input }, { jsonStream }) => {
    const message = await input.valid();
    const eventStream = await openai.responses.create({ /* ... */ });

    return jsonStream(async (stream) => {
      // ...
      await stream.write( /* ... */ );
    });
  },
});`,
    },
    {
      id: "client-builder",
      label: "Client",
      accent: "from-rose-500/80 via-fuchsia-500/70 to-purple-500/80",
      code: `import { createClientBuilder } from "@fragno-dev/core/client";
import { computed } from "nanostores";

export function createMyFragmentClient() {
  const builder = createClientBuilder(myFragmentDefinition, {}, routes);

  const useChatStream = builder.createMutator("POST", "/chat/stream");
  const aggregatedMessage = computed(useChatStream.mutatorStore,
    ({ data }) => /* ... */);

  return {
    useChatStream,
    useAggregatedMessage: builder.createStore(aggregatedMessage),
  };
}`,
    },
    {
      id: "workflow-sketch",
      label: "User",
      accent: "from-amber-500/80 via-orange-500/70 to-rose-500/80",
      code: `import { createMyFragmentClient } from "example-fragment/react";

const { useChatStream, useAggregatedMessage }
    = createMyFragmentClient();

export function Chat() {
  const { mutate, loading } = useChatStream();
  const aggregatedMessage = useAggregatedMessage();

  const [message, setMessage] = useState("");

  return (
    <div>
      <input onChange={(e) => setMessage(e.target.value)} type="text" value={message} />
      <button onClick={() => mutate({ body: { message } })}>
        Send
      </button>
      <div>{loading ? "AI is thinking..." : aggregatedMessage}</div>
    </div>
  );
}`,
    },
  ];

  const [activeTab, setActiveTab] = useState(providesTabs[0].id);

  const highlightItems = [
    {
      icon: <Route className="size-6" />,
      title: "Embed Routes",
      description: "HTTP Routes with automatic frontend bindings",
      background: "bg-[radial-gradient(circle_at_20%_20%,rgba(34,197,94,0.15),transparent_50%)]",
    },
    {
      icon: <Database className="size-6" />,
      title: "State Management",
      description: "Reactive client-side stores with invalidation built in",
      background: "bg-[radial-gradient(circle_at_80%_20%,rgba(59,130,246,0.15),transparent_50%)]",
    },
    {
      icon: <Activity className="size-6" />,
      title: "Streaming Support",
      description: "Real-time newline-delimited JSON streaming",
      background: "bg-[radial-gradient(circle_at_20%_80%,rgba(168,85,247,0.15),transparent_50%)]",
    },
    {
      icon: <Layers className="size-6" />,
      title: "Middleware Support",
      description: "Users can intercept and process requests before they reach your handlers",
      background: "bg-[radial-gradient(circle_at_80%_80%,rgba(245,158,11,0.15),transparent_50%)]",
    },
  ];

  return (
    <section className="w-full max-w-6xl space-y-12">
      <div className="relative flex flex-col items-center gap-12 lg:flex-row lg:items-start">
        <div className="space-y-6 lg:w-2/5">
          <p className="text-fd-muted-foreground font-medium">With Fragno you build</p>
          <h2 className="text-4xl font-extrabold tracking-tight md:text-6xl">
            <span className="text-blue-700 dark:text-blue-400">Full-Stack Libraries</span>
          </h2>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            Traditional libraries integrate on <em>either</em> the frontend <em>or</em> the backend,
            and the user is responsible for the glue-code.
          </p>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            A <u>Fragment</u> does both, it's a full-stack library. Users integrate with only a
            couple lines of code. No glue.
          </p>
          <p className="text-fd-muted-foreground max-w-xl text-lg">10x the developer experience.</p>
        </div>

        <div className="relative min-w-0 flex-1 overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-6 -top-16 h-48 w-48 rounded-full bg-gradient-to-br from-blue-400/25 via-transparent to-transparent blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -left-10 bottom-[-60px] h-40 w-56 rounded-full bg-gradient-to-br from-purple-400/20 via-transparent to-transparent blur-3xl"
          />

          <div className="bg-white/94 relative overflow-hidden rounded-[26px] p-4 shadow-[0_20px_40px_-35px_rgba(59,130,246,0.4)] dark:bg-slate-900/75">
            <div className="bg-white/92 flex flex-wrap gap-2 rounded-full p-1 dark:bg-slate-900/70">
              {providesTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 ${
                    activeTab === tab.id
                      ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                      : "text-slate-700 dark:text-slate-300"
                  }`}
                  aria-pressed={activeTab === tab.id}
                >
                  <span className="relative">{tab.label}</span>
                </button>
              ))}
            </div>
            <div className="bg-white/97 relative rounded-2xl p-2 dark:bg-slate-950/60">
              {activeTab === "server-core" && (
                <p className="text-fd-muted-foreground mb-4 text-sm">
                  Define your API routes with full type safety. Routes are embedded directly in your
                  user's application.
                </p>
              )}
              {activeTab === "client-builder" && (
                <p className="text-fd-muted-foreground mb-4 text-sm">
                  Build reactive client-side stores that call the server routes. Maps reactively to
                  every framework, both ways.
                </p>
              )}
              {activeTab === "workflow-sketch" && (
                <p className="text-fd-muted-foreground mb-4 text-sm">
                  Your user has a seamless experience integrating your Fragment. They get typed,
                  reactive hooks for React, Vue, or Svelte.
                </p>
              )}
              <FragnoCodeBlock
                lang="tsx"
                code={
                  providesTabs.find((tab) => tab.id === activeTab)?.code ?? providesTabs[0].code
                }
              />
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {highlightItems.map((item) => (
          <div
            key={item.title}
            className="dark:border-white/12 relative overflow-hidden rounded-3xl border border-white/20 bg-white/70 p-6 dark:bg-slate-900/70"
          >
            <span
              className={`pointer-events-none absolute inset-0 opacity-30 ${item.background}`}
            />
            <div className="relative flex items-start gap-4">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-white/80 to-white/40 shadow-sm ring-1 ring-black/5 dark:from-slate-800/80 dark:to-slate-800/40 dark:ring-white/10">
                {item.icon}
              </span>
              <div>
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                  {item.title}
                </h3>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-200/80">
                  {item.description}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DocsSection() {
  return (
    <section className="w-full max-w-5xl space-y-8">
      <div className="space-y-4 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Documentation</h2>
        <p className="text-fd-muted-foreground mx-auto max-w-prose text-lg">
          Choose your path depending on whether you're a user or a library author
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Link
          href="/docs/fragno/user-quick-start"
          className="group relative overflow-hidden rounded-2xl bg-white/90 p-8 shadow-sm ring-1 ring-black/5 transition-all hover:-translate-y-1 hover:shadow-xl dark:bg-slate-950/60 dark:from-slate-950/60 dark:via-slate-950/50 dark:to-slate-950/40 dark:ring-white/10"
        >
          <span className="absolute inset-x-6 -top-16 h-28 rounded-full bg-gray-500/10 opacity-0 blur-3xl transition-opacity group-hover:opacity-80 dark:bg-gray-400/15" />
          <div className="relative">
            <div className="mb-4 flex items-center gap-4">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gray-500/10 dark:bg-gray-400/20">
                <BookOpen className="size-6 text-gray-700 dark:text-gray-300" />
              </span>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Quick Start</h3>
                <p className="text-fd-muted-foreground text-sm">For users</p>
              </div>
            </div>
            <p className="text-fd-muted-foreground text-sm">
              Learn how to integrate Fragno Fragments into your application
            </p>
          </div>
        </Link>

        <Link
          href="/docs/fragno/for-library-authors/getting-started"
          className="group relative overflow-hidden rounded-2xl bg-white/90 p-8 shadow-sm ring-1 ring-black/5 transition-all hover:-translate-y-1 hover:shadow-xl dark:bg-slate-950/60 dark:from-slate-950/60 dark:via-slate-950/50 dark:to-slate-950/40 dark:ring-white/10"
        >
          <span className="absolute inset-x-6 -top-16 h-28 rounded-full bg-gray-500/10 opacity-0 blur-3xl transition-opacity group-hover:opacity-80 dark:bg-gray-400/15" />
          <div className="relative">
            <div className="mb-4 flex items-center gap-4">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gray-500/10 dark:bg-gray-400/20">
                <Users className="size-6 text-gray-700 dark:text-gray-300" />
              </span>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Library Authors
                </h3>
                <p className="text-fd-muted-foreground text-sm">For developers</p>
              </div>
            </div>
            <p className="text-fd-muted-foreground text-sm">
              Create your own full-stack libraries. Learn how to build framework-agnostic Fragments.
            </p>
          </div>
        </Link>
      </div>
    </section>
  );
}

function BlogSection() {
  return (
    <section className="mx-auto w-full max-w-5xl">
      <div className="relative overflow-hidden rounded-2xl bg-white/90 p-8 shadow-sm ring-1 ring-black/5 dark:bg-slate-950/60 dark:ring-white/10">
        {/* Background elements similar to blog page */}
        <div className="dark:from-zinc-400/3 dark:via-neutral-400/3 dark:to-stone-400/3 absolute inset-0 bg-gradient-to-r from-zinc-500/5 via-neutral-500/5 to-stone-500/5" />
        <div
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%239C92AC' fill-opacity='0.1'%3E%3Ccircle cx='30' cy='30' r='2'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
          }}
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-10 mix-blend-multiply dark:opacity-5"
          style={{
            backgroundImage:
              "linear-gradient(120deg, rgba(0,0,0,0.05) 25%, transparent 25%, transparent 50%, rgba(0,0,0,0.05) 50%, rgba(0,0,0,0.05) 75%, transparent 75%, transparent)",
            backgroundSize: "24px 24px",
          }}
        />
        <div className="pointer-events-none absolute -right-8 top-8 h-24 w-24 rotate-12 rounded-xl border border-gray-300/30 dark:border-white/5" />

        <div className="relative">
          <div className="flex items-start gap-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-white/80 to-white/40 shadow-sm ring-1 ring-black/5 dark:from-slate-800/80 dark:to-slate-800/40 dark:ring-white/10">
              <FileText className="size-6 text-gray-700 dark:text-gray-300" />
            </div>
            <div className="flex-1">
              <div className="mb-2">
                <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  Blog Post
                </span>
              </div>
              <h3 className="mb-2 text-xl font-semibold text-gray-900 dark:text-white">
                Introduction to Fragno
              </h3>
              <p className="mb-4 text-gray-600 dark:text-gray-300">
                Understand the philosophy and vision behind Fragno. Learn why we think a
                framework-agnostic approach to building full-stack libraries is a great choice.
              </p>
              <Link
                href="/blog/fragno-introduction"
                className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 font-medium text-white shadow-sm transition-colors hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
              >
                Read Introduction
              </Link>
              {/* <div className="inline-flex items-center gap-2 rounded-lg bg-gray-100 px-4 py-2 font-medium text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
                <span>Check Back Soon</span>
              </div> */}
            </div>
          </div>
        </div>

        <span className="pointer-events-none absolute -bottom-6 left-1/2 h-24 w-[110%] -translate-x-1/2 rounded-full bg-gradient-to-r from-transparent via-white/20 to-transparent opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100" />
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col items-center space-y-12 overflow-x-hidden px-4 py-16 md:px-8">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="mx-auto mt-[-80px] h-[520px] w-[820px] rounded-full bg-gradient-to-br from-blue-500/25 via-sky-400/20 to-purple-500/20 opacity-20 blur-3xl dark:opacity-40" />
      </div>

      <Hero />
      <BentoCake />
      <Frameworks />
      <WhatFragnoProvides />
      {/* <Features /> */}

      <div className="mt-8 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <DatabaseIntegration />
      <div className="mt-8 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />

      <DocsSection />
      <BlogSection />
    </main>
  );
}
