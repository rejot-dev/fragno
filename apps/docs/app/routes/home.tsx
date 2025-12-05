import { useState } from "react";
import { Link, Form, useActionData, useNavigation } from "react-router";
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
  Users,
  MessageCircleMore,
  Mail,
} from "lucide-react";

import Frameworks from "@/components/frameworks";
import DatabaseIntegration from "@/components/database-integration";
import { GitHub } from "@/components/logos/github";
import type { Route } from "./+types/home";
import { getMailingListDurableObject } from "@/cloudflare/cloudflare-utils";
import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import { validateTurnstileToken } from "@/cloudflare/turnstile";
import { Turnstile } from "@marsidev/react-turnstile";
import { FragnoExplainer } from "@/components/explainer";

export function meta() {
  return [
    { title: "Fragno: Full-Stack TypeScript Libraries" },
    {
      name: "description",
      content:
        "Fragno is the toolkit for building full-stack TypeScript libraries that work seamlessly across frameworks",
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
    <section className="w-full max-w-5xl space-y-6 py-8 text-center md:py-16">
      <h1 className="text-fd-foreground dark:bg-linear-to-b text-5xl font-extrabold tracking-tight md:text-6xl lg:text-7xl dark:from-white dark:to-white/70 dark:bg-clip-text dark:text-transparent">
        Full-Stack{" "}
        <span className="text-fd-foreground dark:bg-linear-to-b relative inline-block dark:from-white dark:to-white/70 dark:bg-clip-text dark:text-transparent">
          TypeScript
          <span className="absolute -right-3 -top-2 inline-flex rotate-12 items-center md:-right-7 md:-top-3">
            <span className="bg-linear-to-r relative inline-flex items-center gap-2 rounded-full from-slate-600 via-gray-600 to-zinc-600 px-4 py-1.5 text-white shadow-[0_12px_30px_-12px_rgba(99,102,241,0.65)] ring-1 ring-white/20">
              <span
                aria-hidden
                className="bg-linear-to-r pointer-events-none absolute -inset-0.5 -z-10 rounded-full from-indigo-500/30 to-fuchsia-500/30 blur-md"
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
      <p className="text-fd-foreground mx-auto max-w-3xl text-lg md:text-2xl md:leading-10">
        A toolkit for building libraries that bundle database schemas, backend routes and frontend
        hooks into one package.
      </p>

      <div className="flex flex-col items-center justify-center gap-3 pt-2 sm:flex-row">
        <Link
          to="/docs/fragno"
          className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
        >
          View Docs
        </Link>
        <a
          href="https://github.com/rejot-dev/fragno"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg border border-gray-300 px-6 py-3 font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <GitHub className="size-4" />
          Star on GitHub
        </a>
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
          className={`flex items-center justify-center rounded-xl p-3 text-2xl ${iconClass ?? "bg-blue-500/15 dark:bg-blue-400/20"}`}
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
        icon={<Target className="size-6" />}
        title="Framework agnostic"
        description="Works with React, Vue, Next.js, Nuxt, React Router, and more."
        glowClass="bg-blue-500/10 dark:bg-blue-400/20"
        iconClass="bg-blue-500/10 dark:bg-blue-400/20"
      />
      <FeatureCard
        icon={<Shield className="size-6" />}
        title="End-to-end type safety"
        description="From server to client, everything is typed."
        glowClass="bg-blue-500/10 dark:bg-blue-400/20"
        iconClass="bg-blue-500/10 dark:bg-blue-400/20"
      />
      <FeatureCard
        icon={<Package className="size-6" />}
        title="Automatic code splitting"
        description="Server code never reaches the client bundle."
        glowClass="bg-blue-500/10 dark:bg-blue-400/20"
        iconClass="bg-blue-500/10 dark:bg-blue-400/20"
      />
      <FeatureCard
        icon={<Rocket className="size-6" />}
        title="Built-in state management"
        description="Reactive stores with caching built in."
        glowClass="bg-blue-500/10 dark:bg-blue-400/20"
        iconClass="bg-blue-500/10 dark:bg-blue-400/20"
      />
      <FeatureCard
        icon={<Waves className="size-6" />}
        title="Streaming support"
        description="Real-time NDJSON streaming for live data."
        glowClass="bg-blue-500/10 dark:bg-blue-400/20"
        iconClass="bg-blue-500/10 dark:bg-blue-400/20"
      />
      <FeatureCard
        icon={<RotateCcw className="size-6" />}
        title="Middleware support"
        description="Compose auth and custom request processing."
        glowClass="bg-blue-500/10 dark:bg-blue-400/20"
        iconClass="bg-blue-500/10 dark:bg-blue-400/20"
      />
    </section>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
          to="/docs/fragno/for-library-authors/getting-started"
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

        <Link
          to="/docs/fragno/user-quick-start"
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
      </div>
    </section>
  );
}

function CommunitySection({ turnstileSitekey }: { turnstileSitekey: string }) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <section className="w-full max-w-5xl space-y-8">
      <div className="space-y-4 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Join the Community</h2>
        <p className="text-fd-muted-foreground mx-auto max-w-prose text-lg">
          Connect with other developers and stay updated on the latest developments
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Discord Section */}
        <a
          href="https://discord.gg/jdXZxyGCnC"
          target="_blank"
          rel="noopener noreferrer"
          className="group relative overflow-hidden rounded-2xl bg-white/90 p-8 shadow-sm ring-1 ring-black/5 transition-all hover:-translate-y-1 hover:shadow-xl dark:bg-slate-950/60 dark:ring-white/10"
        >
          <span className="absolute inset-x-6 -top-16 h-28 rounded-full bg-blue-600/10 opacity-0 blur-3xl transition-opacity group-hover:opacity-80 dark:bg-blue-600/15" />
          <div className="relative">
            <div className="mb-4 flex items-center gap-4">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600/10 dark:bg-blue-600/20">
                <MessageCircleMore className="size-6 text-blue-600 dark:text-blue-400" />
              </span>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Discord</h3>
                <p className="text-fd-muted-foreground text-sm">Join the conversation</p>
              </div>
            </div>
            <p className="text-fd-muted-foreground mb-4 text-sm">
              Connect with the community, get help with your projects, and stay updated on the
              latest features and releases.
            </p>
            <span className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 transition-all group-hover:gap-2 dark:text-blue-400">
              Join Discord
              <span className="transition-transform group-hover:translate-x-0.5">→</span>
            </span>
          </div>
        </a>

        {/* Mailing List Section */}
        <div className="group relative overflow-hidden rounded-2xl bg-white/90 p-8 shadow-sm ring-1 ring-black/5 dark:bg-slate-950/60 dark:ring-white/10">
          <div className="relative">
            <div className="mb-4 flex items-center gap-4">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600/10 dark:bg-blue-600/20">
                <Mail className="size-6 text-blue-600 dark:text-blue-400" />
              </span>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Newsletter</h3>
                <p className="text-fd-muted-foreground text-sm">Get email updates</p>
              </div>
            </div>
            <p className="text-fd-muted-foreground mb-4 text-sm">
              Receive notifications about new features, releases, and important announcements.
            </p>
            <Form method="post" className="flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  type="email"
                  name="email"
                  placeholder="your@email.com"
                  required
                  disabled={isSubmitting}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600 disabled:opacity-50 dark:border-gray-600 dark:bg-slate-800/50 dark:text-white dark:placeholder:text-gray-400"
                />
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {isSubmitting ? "..." : "Subscribe"}
                </button>
              </div>
              {actionData?.message && (
                <p
                  className={`text-sm ${
                    actionData.success
                      ? "text-green-600 dark:text-green-400"
                      : "text-red-600 dark:text-red-400"
                  }`}
                >
                  {actionData.message}
                </p>
              )}
              <Turnstile siteKey={turnstileSitekey} options={{ appearance: "interaction-only" }} />
            </Form>
          </div>
        </div>
      </div>
    </section>
  );
}

function UseCases() {
  return (
    <section className="w-full max-w-6xl space-y-12">
      <div className="space-y-4 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">When to use Fragno</h2>
      </div>
      <div className="relative flex flex-col items-start gap-12 lg:flex-row">
        <div className="space-y-6 lg:w-1/2">
          <p className="text-fd-muted-foreground font-medium">More than an API client</p>
          <h2 className="text-3xl font-extrabold tracking-tight md:text-4xl">
            <span className="text-blue-700 dark:text-blue-400">Full-stack SDKs</span>
          </h2>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            Most SDKs only wrap API calls. Developers still have to write things like webhook
            handlers that persist events or build their own frontend hooks.
          </p>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            With Fragno you can ship a pre-built integration for your product.
          </p>
        </div>

        <div className="space-y-6 lg:w-1/2">
          <p className="text-fd-muted-foreground font-medium">Do not repeat yourself</p>
          <h2 className="text-3xl font-extrabold tracking-tight md:text-4xl">
            <span className="text-blue-700 dark:text-blue-400">Full-Stack Components</span>
          </h2>
          <p className="text-fd-muted-foreground max-w-xl text-lg">
            Build components that can be reused across applications regardless of which stack they
            use.
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

export default function HomePage({ loaderData }: Route.ComponentProps) {
  const { turnstileSitekey } = loaderData;
  return (
    <main className="space-y-18 relative flex flex-1 flex-col items-center overflow-x-hidden px-4 py-16 md:px-8">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="bg-linear-to-br opacity-4 mx-auto -mt-20 h-[520px] w-[1000px] from-blue-500 via-sky-400 to-purple-500 blur-3xl dark:opacity-15" />
      </div>

      <Hero />
      <FragnoExplainer />
      <div className="mt-8 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <UseCases />
      <div className="mt-8 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <Frameworks />
      {/*<WhatFragnoProvides />*/}
      <div className="mt-8 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <Features />

      <div className="mt-8 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />
      <DatabaseIntegration />
      <div className="mt-8 w-full max-w-5xl border-t border-black/5 dark:border-white/10" />

      <DocsSection />
      <CommunitySection turnstileSitekey={turnstileSitekey} />
    </main>
  );
}
