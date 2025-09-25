"use client";

import { useState } from "react";
import Link from "next/link";
import { FragnoLogo } from "@/components/logos/fragno-logo";
import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";

function Hero() {
  return (
    <section className="w-full max-w-5xl space-y-6 text-center">
      <div className="flex justify-center">
        <FragnoLogo className="size-72 dark:text-white" />
      </div>

      <h1 className="text-fd-foreground text-6xl font-extrabold tracking-tight md:text-7xl dark:bg-gradient-to-b dark:from-white dark:to-white/70 dark:bg-clip-text dark:text-transparent">
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
  );
}

type FeatureCardProps = {
  icon: string;
  title: string;
  description: string;
  glowClass?: string;
  iconClass?: string;
};

function FeatureCard({ icon, title, description, glowClass, iconClass }: FeatureCardProps) {
  return (
    <div className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-white/90 via-white/80 to-white/80 p-6 shadow-sm ring-1 ring-black/5 transition-all hover:-translate-y-1 hover:shadow-xl dark:from-slate-950/60 dark:via-slate-950/50 dark:to-slate-950/40 dark:ring-white/10">
      <span
        className={`absolute inset-x-6 -top-16 h-28 rounded-full opacity-0 blur-3xl transition-opacity group-hover:opacity-80 ${glowClass ?? "bg-blue-500/15 dark:bg-blue-400/20"}`}
      />
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

function Features() {
  return (
    <section className="mt-14 grid w-full max-w-6xl gap-6 md:grid-cols-3">
      <FeatureCard
        icon="🔐"
        title="End-to-end type safety"
        description="From server to client, everything is typed."
        glowClass="bg-blue-500/15 dark:bg-blue-400/20"
        iconClass="bg-blue-500/15 dark:bg-blue-400/20"
      />
      <FeatureCard
        icon="🎯"
        title="Framework agnostic"
        description="Works with React, Vue, Next.js, Nuxt, React Router."
        glowClass="bg-purple-500/15 dark:bg-purple-400/20"
        iconClass="bg-purple-500/15 dark:bg-purple-400/20"
      />
      <FeatureCard
        icon="📦"
        title="Automatic code splitting"
        description="Server code never reaches the client bundle."
        glowClass="bg-rose-500/15 dark:bg-rose-400/20"
        iconClass="bg-rose-500/15 dark:bg-rose-400/20"
      />
      <FeatureCard
        icon="🚀"
        title="Built-in state management"
        description="Reactive stores with caching built in."
        glowClass="bg-emerald-500/15 dark:bg-emerald-400/20"
        iconClass="bg-emerald-500/15 dark:bg-emerald-400/20"
      />
      <FeatureCard
        icon="🌊"
        title="Streaming support"
        description="Real-time NDJSON streaming for live data."
        glowClass="bg-sky-500/15 dark:bg-sky-400/20"
        iconClass="bg-sky-500/15 dark:bg-sky-400/20"
      />
      <FeatureCard
        icon="🔄"
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
      label: "Server Core",
      accent: "from-sky-500/80 via-blue-500/70 to-indigo-500/80",
      code: `import { createServer, file } from "fragno";

const app = createServer();

app.get('/', () => 'Hello World');

app.get('/image', () => file('fragno.svg'));

app.get('/stream', async function* () {
  yield 'Hello';
  yield 'World';
});

app.ws('/realtime', {
  message(ws, message) {
    ws.send('got: ' + message);
  }
});

app.listen(3000);`,
    },
    {
      id: "client-bridge",
      label: "Client Bridge",
      accent: "from-rose-500/80 via-fuchsia-500/70 to-purple-500/80",
      code: `// TODO: hydrate your client bridge here
const bridge = createFragment();

bridge.on("todos", (payload) => {
  console.log("hydrate", payload);
});

export const useTodos = () => bridge.subscribe("todos");`,
    },
    {
      id: "workflow-sketch",
      label: "Workflow Sketch",
      accent: "from-amber-500/80 via-orange-500/70 to-rose-500/80",
      code: `// TODO: choreograph a workflow
async function* orchestrateWorkflow() {
  yield "connect";
  yield "transform";
  yield "deliver";
}

export async function pipe(output) {
  for await (const event of orchestrateWorkflow()) {
    output(event);
  }
}`,
    },
  ];

  const [activeTab, setActiveTab] = useState(providesTabs[0].id);

  const highlightItems = [
    {
      icon: "🧩",
      title: "Just return",
      description: "Return strings, numbers, files, or JSON.",
      background: "bg-[radial-gradient(circle_at_10%_-20%,rgba(16,185,129,0.24),transparent_58%)]",
    },
    {
      icon: "📁",
      title: "File support built-in",
      description: "Send files by simply returning them.",
      background: "bg-[radial-gradient(circle_at_90%_0%,rgba(56,189,248,0.22),transparent_60%)]",
    },
    {
      icon: "🌊",
      title: "Stream response",
      description: "Use generators to stream data.",
      background: "bg-[radial-gradient(circle_at_80%_20%,rgba(168,85,247,0.22),transparent_62%)]",
    },
    {
      icon: "📡",
      title: "Data in real-time",
      description: "WebSocket helpers in just a few lines.",
      background: "bg-[radial-gradient(circle_at_50%_120%,rgba(251,191,36,0.28),transparent_65%)]",
    },
  ];

  return (
    <section className="mt-16 w-full max-w-6xl space-y-12">
      <div className="relative grid items-start gap-10 md:grid-cols-[1.05fr_minmax(0,0.95fr)]">
        <div className="space-y-5">
          <p className="text-fd-muted-foreground font-medium">What Fragno Provides</p>
          <h2 className="text-4xl font-extrabold tracking-tight md:text-6xl">
            <span className="bg-gradient-to-b from-pink-500 to-rose-400 bg-clip-text text-transparent dark:from-pink-400 dark:to-rose-300">
              End-to-end Integration
            </span>
          </h2>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            Traditional libraries integrate on <em>either</em> the front-end <em>or</em> the
            back-end, and the user is responsible for the glue-code.
          </p>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            A Fragment does both, it's a full-stack library. The user integrates with only a couple
            lines of code. No glue.
          </p>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            All major frameworks are supported.
          </p>
        </div>

        <div className="relative">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-6 -top-16 h-48 w-48 rounded-full bg-gradient-to-br from-blue-400/25 via-transparent to-transparent blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -left-10 bottom-[-60px] h-40 w-56 rounded-full bg-gradient-to-br from-purple-400/20 via-transparent to-transparent blur-3xl"
          />

          <div className="bg-white/94 relative overflow-hidden rounded-[26px] p-4 shadow-[0_20px_40px_-35px_rgba(59,130,246,0.4)] transition-transform duration-500 dark:bg-slate-900/75">
            <div className="bg-white/92 flex flex-wrap gap-2 rounded-full p-1 dark:bg-slate-900/70">
              {providesTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 ${
                    activeTab === tab.id
                      ? `bg-gradient-to-r ${tab.accent} text-white shadow-sm`
                      : "text-slate-600 hover:text-slate-900 dark:text-slate-100/70 dark:hover:text-white"
                  }`}
                  aria-pressed={activeTab === tab.id}
                >
                  <span className="relative">{tab.label}</span>
                </button>
              ))}
            </div>
            <div className="bg-white/97 relative mt-4 rounded-2xl p-3.5 dark:bg-slate-950/60">
              <DynamicCodeBlock
                lang="ts"
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
            className="dark:border-white/12 group relative overflow-hidden rounded-3xl border border-white/20 bg-white/70 p-6 transition-all duration-500 hover:border-white/35 hover:shadow-[0_22px_50px_-36px_rgba(30,64,175,0.7)] dark:bg-slate-900/70"
          >
            <span
              className={`pointer-events-none absolute inset-0 opacity-40 transition-opacity duration-500 group-hover:opacity-75 ${item.background}`}
            />
            <div className="relative flex items-start gap-4">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-slate-900/5 text-2xl transition-colors duration-500 group-hover:bg-slate-900/10 dark:bg-white/10 dark:group-hover:bg-white/20">
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
            <span className="pointer-events-none absolute -bottom-6 left-1/2 h-24 w-[110%] -translate-x-1/2 rounded-full bg-gradient-to-r from-transparent via-white/35 to-transparent opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100" />
          </div>
        ))}
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col items-center px-4 py-16">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="mx-auto mt-[-80px] h-[520px] w-[820px] rounded-full bg-gradient-to-br from-blue-500/25 via-sky-400/20 to-purple-500/20 opacity-20 blur-3xl dark:opacity-40" />
      </div>

      <Hero />

      <Features />

      <WhatFragnoProvides />

      <section className="mt-16 w-full max-w-6xl">
        <div className="bg-fd-card/90 rounded-3xl p-[1px] shadow-[0_32px_55px_-35px_rgba(79,70,229,0.75)]">
          <div className="rounded-[26px] bg-gradient-to-b from-white/90 to-white/70 p-4 md:p-6 dark:from-slate-900/80 dark:to-slate-900/60">
            <DynamicCodeBlock
              lang="ts"
              code={`import { defineFragment, defineRoute, createFragment } from "@fragno-dev/core";

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
