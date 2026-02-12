import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { FragnoCodeBlock } from "@/components/fragno-code-block";
import {
  Shield,
  Target,
  Package,
  Rocket,
  Waves,
  RotateCcw,
  Route as RouteIcon,
  Database,
  Activity,
  Layers,
  BookOpen,
} from "lucide-react";

import Frameworks from "@/components/frameworks";
import DatabaseIntegration from "@/components/database-integration";
import { DatabaseSupport } from "@/components/database-support";
import type { Route } from "./+types/authors";
import { getMailingListDurableObject } from "@/cloudflare/cloudflare-utils";
import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import { validateTurnstileToken } from "@/cloudflare/turnstile";
import { SkillCta } from "@/components/skill-cta";
import { CommunitySection } from "@/components/community-section";
import { Cake } from "@/components/logos/cakes";

export function meta() {
  return [
    { title: "Fragno for Authors: Build Full-Stack Fragments" },
    {
      name: "description",
      content:
        "Build portable full-stack TypeScript libraries with routes, hooks, and database schemas built in.",
    },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(CloudflareContext);
  return {
    turnstileSitekey: env.TURNSTILE_SITEKEY,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(CloudflareContext);
  const formData = await request.formData();
  const email = formData.get("email");

  if (!email || typeof email !== "string") {
    return {
      success: false,
      message: "Email is required",
    };
  }

  const turnstileToken = formData.get("cf-turnstile-response");
  if (!turnstileToken || typeof turnstileToken !== "string") {
    return {
      success: false,
      message: "Turnstile token is required",
    };
  }

  const turnstileResult = await validateTurnstileToken(env.TURNSTILE_SECRET_KEY, turnstileToken);
  if (!turnstileResult.success) {
    return {
      success: false,
      message: "Turnstile validation failed",
    };
  }

  try {
    const mailingListDo = getMailingListDurableObject(context);
    await mailingListDo.subscribe(email);

    return {
      success: true,
      message: "Successfully subscribed!",
    };
  } catch (error) {
    console.error("Mailing list subscription error:", error);
    return {
      success: false,
      message: "Failed to subscribe. Please try again.",
    };
  }
}

function Hero() {
  return (
    <section className="w-full max-w-6xl py-6 md:py-10">
      <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
        <div className="space-y-6">
          <h1 className="text-4xl font-extrabold tracking-tight md:text-6xl">
            Build portable full-stack libraries
          </h1>
          <p className="text-fd-muted-foreground max-w-xl text-lg md:text-xl">
            Define routes, schemas, and client hooks once. Ship fragments that integrate into any
            framework with a few lines of code.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              to="/docs/fragno/for-library-authors/getting-started"
              className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
            >
              Getting Started
            </Link>
          </div>
          <p className="text-fd-muted-foreground text-sm">
            Just integrating fragments?{" "}
            <Link to="/" className="font-medium text-blue-600 hover:underline">
              Visit the user landing
            </Link>
          </p>
        </div>

        <div className="relative">
          <SkillCta
            title="Install the Fragno Author Skill"
            command="npx skills add https://github.com/rejot-dev/fragno --skill fragno-author"
            description='Then ask: "Use fragno-author to scaffold a fragment with routes and hooks."'
          />
        </div>
      </div>
    </section>
  );
}

type FeatureCardProps = {
  icon: ReactNode;
  title: string;
  description: string;
  iconClass?: string;
};

function FeatureCard({ icon, title, description, iconClass }: FeatureCardProps) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-white/90 p-6 shadow-sm ring-1 ring-black/5 dark:bg-slate-950/60 dark:ring-white/10">
      <div className="relative flex items-start gap-3">
        <span
          className={`flex items-center justify-center rounded-xl p-3 text-2xl ${
            iconClass ?? "bg-blue-500/15 dark:bg-blue-400/20"
          }`}
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
    <section className="grid w-full max-w-6xl gap-6 md:grid-cols-3">
      <FeatureCard
        icon={<Target className="size-6" />}
        title="Framework-agnostic"
        description="Works with React, Vue, Svelte, Solid and related full-stack frameworks."
        iconClass="bg-blue-500/10 dark:bg-blue-400/20"
      />
      <FeatureCard
        icon={<Shield className="size-6" />}
        title="End-to-end type safety"
        description="From server to client to database, everything is typed."
        iconClass="bg-blue-500/10 dark:bg-blue-400/20"
      />
      <FeatureCard
        icon={<Package className="size-6" />}
        title="Automatic code splitting"
        description="Server code never reaches the client bundle."
        iconClass="bg-blue-500/10 dark:bg-blue-400/20"
      />
      <FeatureCard
        icon={<Rocket className="size-6" />}
        title="Built-in state management"
        description="Reactive stores with caching built in."
        iconClass="bg-blue-500/10 dark:bg-blue-400/20"
      />
      <FeatureCard
        icon={<Waves className="size-6" />}
        title="Streaming support"
        description="Real-time NDJSON streaming for live data."
        iconClass="bg-blue-500/10 dark:bg-blue-400/20"
      />
      <FeatureCard
        icon={<RotateCcw className="size-6" />}
        title="Middleware support"
        description="Compose auth and custom request processing."
        iconClass="bg-blue-500/10 dark:bg-blue-400/20"
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
      id: "database-schema",
      label: "Database",
      accent: "from-emerald-500/80 via-teal-500/70 to-cyan-500/80",
      code: `import { schema, column, idColumn } from "@fragno-dev/db";

export const fragmentSchema = schema("chat", (s) => {
  return s.addTable("message", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("body", column("text"))
      .addColumn("createdAt", column("timestamp"));
  });
});`,
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
      icon: <RouteIcon className="size-6" />,
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
          <div className="text-fd-muted-foreground flex items-center font-medium">
            <Cake
              variant="cake-crumbs"
              className="dark:drop-shadow-slate-600 mr-2 size-12 md:size-16 dark:drop-shadow-md"
            />
            <span>With Fragno you build</span>
          </div>
          <h2 className="text-4xl font-extrabold tracking-tight md:text-6xl">
            <span className="text-blue-700 dark:text-blue-400">Full-Stack Libraries</span>
          </h2>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            Traditional libraries integrate on <em>either</em> the frontend <em>or</em> the backend,
            and the user is responsible for the glue-code.
          </p>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            A <u>full-stack library</u> does both. Users integrate with only a couple of lines of
            code. No glue.
          </p>
          <p className="text-fd-muted-foreground max-w-xl text-lg">10x the developer experience.</p>
        </div>

        <div className="relative min-w-0 flex-1 overflow-hidden">
          <div
            aria-hidden
            className="bg-linear-to-br pointer-events-none absolute -right-6 -top-16 h-48 w-48 rounded-full from-blue-400/25 via-transparent to-transparent blur-3xl"
          />
          <div
            aria-hidden
            className="bg-linear-to-br pointer-events-none absolute -left-10 bottom-[-60px] h-40 w-56 rounded-full from-purple-400/20 via-transparent to-transparent blur-3xl"
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
              {activeTab === "database-schema" && (
                <p className="text-fd-muted-foreground mb-4 text-sm">
                  Define schemas and migrations that merge into the user&apos;s database with typed
                  access from your routes.
                </p>
              )}
              {activeTab === "workflow-sketch" && (
                <p className="text-fd-muted-foreground mb-4 text-sm">
                  Your user has a seamless experience integrating your library. They get typed,
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
              <span className="bg-linear-to-br flex h-11 w-11 items-center justify-center rounded-xl from-white/80 to-white/40 shadow-sm ring-1 ring-black/5 dark:from-slate-800/80 dark:to-slate-800/40 dark:ring-white/10">
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

function UseCases() {
  return (
    <section className="relative w-full max-w-6xl space-y-12">
      <div aria-hidden className="pointer-events-none absolute -right-12 -top-16 hidden lg:block">
        <Cake
          variant="cake-full"
          className="dark:drop-shadow-slate-600 size-48 md:size-64 dark:drop-shadow-md"
        />
      </div>
      <div className="space-y-4 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">When to build a fragment</h2>
      </div>
      <div className="relative flex flex-col items-start gap-12 lg:flex-row">
        <div className="space-y-6 lg:w-1/2">
          <p className="text-fd-muted-foreground font-medium">More than an API client</p>
          <h2 className="text-3xl font-extrabold tracking-tight md:text-4xl">
            <span className="text-blue-700 dark:text-blue-400">Full-stack SDKs</span>
          </h2>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            Most SDKs simply wrap API calls. Developers still have to write things like webhook
            handlers that persist events or build their own frontend hooks.
          </p>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            With Fragno you can ship a pre-built integration for your product.
          </p>
        </div>

        <div className="space-y-6 lg:w-1/2">
          <p className="text-fd-muted-foreground font-medium">Do not repeat yourself</p>
          <h2 className="text-3xl font-extrabold tracking-tight md:text-4xl">
            <span className="text-blue-700 dark:text-blue-400">Full-stack Components</span>
          </h2>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            Build components that can be reused across applications regardless of their stack.
          </p>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            Use community-made Fragments like the Stripe Fragment to add functionality you don't
            want to maintain yourself.
          </p>
        </div>
      </div>
    </section>
  );
}

function AuthorDocsSection() {
  return (
    <section className="w-full max-w-5xl space-y-8">
      <div className="space-y-4 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Author documentation</h2>
        <p className="text-fd-muted-foreground mx-auto max-w-prose text-lg">
          Learn the author workflow and ship your first fragment.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Link
          to="/docs/fragno/for-library-authors/getting-started"
          className="group relative overflow-hidden rounded-2xl bg-white/90 p-8 shadow-sm ring-1 ring-black/5 transition-all hover:-translate-y-1 hover:shadow-xl dark:bg-slate-950/60 dark:ring-white/10"
        >
          <span className="absolute inset-x-6 -top-16 h-28 rounded-full bg-blue-500/10 opacity-0 blur-3xl transition-opacity group-hover:opacity-80 dark:bg-blue-500/15" />
          <div className="relative">
            <div className="mb-4 flex items-center gap-4">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-500/10 dark:bg-blue-500/20">
                <BookOpen className="size-6 text-blue-600 dark:text-blue-400" />
              </span>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Getting Started
                </h3>
                <p className="text-fd-muted-foreground text-sm">Author workflow</p>
              </div>
            </div>
            <p className="text-fd-muted-foreground text-sm">
              Scaffold a fragment, define routes, and generate framework clients.
            </p>
          </div>
        </Link>

        <Link
          to="/docs/fragno/for-library-authors/database-integration/overview"
          className="group relative overflow-hidden rounded-2xl bg-white/90 p-8 shadow-sm ring-1 ring-black/5 transition-all hover:-translate-y-1 hover:shadow-xl dark:bg-slate-950/60 dark:ring-white/10"
        >
          <span className="absolute inset-x-6 -top-16 h-28 rounded-full bg-indigo-500/10 opacity-0 blur-3xl transition-opacity group-hover:opacity-80 dark:bg-indigo-500/15" />
          <div className="relative">
            <div className="mb-4 flex items-center gap-4">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/10 dark:bg-indigo-500/20">
                <Database className="size-6 text-indigo-600 dark:text-indigo-400" />
              </span>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Database Integration
                </h3>
                <p className="text-fd-muted-foreground text-sm">Schemas and migrations</p>
              </div>
            </div>
            <p className="text-fd-muted-foreground text-sm">
              Learn how to define schemas, migrations, and adapters for user databases.
            </p>
          </div>
        </Link>
      </div>
    </section>
  );
}

function UserCta() {
  return (
    <section className="w-full max-w-5xl">
      <div className="relative overflow-hidden rounded-3xl bg-slate-900 px-8 py-10 text-white shadow-xl">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-10 top-0 h-40 w-40 rounded-full bg-blue-500/30 blur-3xl" />
          <div className="absolute -right-10 bottom-0 h-40 w-40 rounded-full bg-purple-500/30 blur-3xl" />
        </div>
        <div className="relative flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <p className="text-sm font-semibold uppercase tracking-wide text-blue-200">
              Integrating fragments?
            </p>
            <h2 className="text-3xl font-bold">Go to the user landing</h2>
            <p className="text-blue-100">
              Find ready-made fragments and integration steps for your app.
            </p>
          </div>
          <Link
            to="/"
            className="rounded-lg bg-white px-6 py-3 font-semibold text-slate-900 shadow-sm transition-colors hover:bg-slate-100"
          >
            User Landing
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function AuthorsPage({ loaderData }: Route.ComponentProps) {
  const { turnstileSitekey } = loaderData;
  return (
    <main className="relative flex flex-1 flex-col items-center space-y-12 overflow-x-hidden px-4 py-10 md:px-8 md:py-12">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="bg-linear-to-br opacity-4 mx-auto -mt-20 h-[520px] w-[1000px] from-blue-500 via-sky-400 to-purple-500 blur-3xl dark:opacity-15" />
      </div>

      <Hero />
      <UseCases />
      <div className="mt-6 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <WhatFragnoProvides />
      <div className="mt-6 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <Features />
      <div className="mt-6 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <DatabaseIntegration />
      <div className="mt-6 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <Frameworks />
      <div className="mt-6 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <DatabaseSupport />
      <div className="mt-6 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <AuthorDocsSection />
      <div className="mt-6 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <CommunitySection turnstileSitekey={turnstileSitekey} />
      <div className="mt-6 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <UserCta />
    </main>
  );
}
