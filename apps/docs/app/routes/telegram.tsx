import {
  Activity,
  Bot,
  MessageSquare,
  Route as RouteIcon,
  ShieldCheck,
  Terminal,
  Users,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { FragmentSubnav } from "@/components/fragment-subnav";
import { FragnoCodeBlock } from "@/components/fragno-code-block";

export function meta() {
  return [
    { title: "Telegram Fragment" },
    {
      name: "description",
      content:
        "Build Telegram bots with durable webhooks, command registry, chat tracking, and typed hooks.",
    },
  ];
}

type Feature = {
  title: string;
  description: string;
  icon: ReactNode;
  accent: string;
};

type Step = {
  title: string;
  description: string;
  lang: "bash" | "ts";
  code: string;
};

const features: Feature[] = [
  {
    title: "Durable webhook intake",
    description: "Process updates once, write durable hooks, and retry safely.",
    icon: <ShieldCheck className="size-5" />,
    accent: "border-teal-400/40 text-teal-600 dark:text-teal-300",
  },
  {
    title: "Command registry",
    description: "Declare commands, scopes, and handlers in one typed place.",
    icon: <Terminal className="size-5" />,
    accent: "border-sky-400/40 text-sky-600 dark:text-sky-300",
  },
  {
    title: "Chat + member sync",
    description: "Persist chats, members, and messages in your database.",
    icon: <Users className="size-5" />,
    accent: "border-cyan-400/40 text-cyan-600 dark:text-cyan-300",
  },
  {
    title: "Typed client hooks",
    description: "Query chats and send messages with generated hooks.",
    icon: <Activity className="size-5" />,
    accent: "border-emerald-400/40 text-emerald-600 dark:text-emerald-300",
  },
];

const setupSteps: Step[] = [
  {
    title: "1. Install",
    description: "Install the Telegram fragment and Fragno DB.",
    lang: "bash",
    code: "npm install @fragno-dev/telegram-fragment @fragno-dev/db",
  },
  {
    title: "2. Configure the fragment",
    description: "Declare commands, hooks, and credentials.",
    lang: "ts",
    code: `import { createTelegramFragment, createTelegram, defineCommand } from "@fragno-dev/telegram-fragment";

const telegramConfig = createTelegram({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET!,
  botUsername: "my_bot",
  hooks: {
    onMessageReceived: async ({ messageId, chatId }) => {
      console.log("New message", messageId, "in", chatId);
    },
  },
})
  .command(
    defineCommand("ping", {
      description: "Ping the bot",
      scopes: ["private", "group", "supergroup"],
      handler: async ({ api, chat }) => {
        await api.sendMessage({ chat_id: chat.id, text: "pong" });
      },
    }),
  )
  .build();

export const telegramFragment = createTelegramFragment(telegramConfig, {
  databaseAdapter: "drizzle-pglite",
});`,
  },
  {
    title: "3. Mount routes",
    description: "Expose the webhook + command endpoints in your app.",
    lang: "ts",
    code: `import { telegramFragment } from "@/lib/telegram";

export const handlers = telegramFragment.handlersFor("react-router");
export const action = handlers.action;
export const loader = handlers.loader;`,
  },
  {
    title: "4. Create a client",
    description: "Generate typed hooks for chats and messages.",
    lang: "ts",
    code: `import { createTelegramFragmentClient } from "@fragno-dev/telegram-fragment/react";

export const telegramClient = createTelegramFragmentClient();`,
  },
];

const commandSnippet = `const { data: commands } = telegramClient.useCommands();
const { mutate: bindCommand } = telegramClient.useBindCommand();

await bindCommand({
  body: { chatId: "123", commandName: "ping", enabled: true },
});`;

const sendSnippet = `const { mutate: sendMessage, loading } = telegramClient.useSendMessage();

await sendMessage({
  path: { chatId: "123" },
  body: { text: "Hello from Fragno" },
});`;

const routes = [
  "POST /telegram/webhook",
  "POST /commands/bind",
  "GET /commands",
  "GET /chats",
  "GET /chats/:chatId",
  "GET /chats/:chatId/messages",
  "POST /chats/:chatId/actions",
  "POST /chats/:chatId/send",
  "POST /chats/:chatId/messages/:messageId/edit",
];

export default function TelegramPage() {
  return (
    <main className="relative min-h-screen overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute top-[-120px] -left-32 h-[420px] w-[420px] rounded-full bg-teal-500/20 blur-[140px] dark:bg-teal-400/20" />
        <div className="absolute top-20 -right-32 h-[420px] w-[420px] rounded-full bg-sky-500/20 blur-[140px] dark:bg-sky-400/20" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(14,116,144,0.12)_1px,transparent_0)] [background-size:28px_28px]" />
      </div>

      <div className="mx-auto max-w-7xl space-y-16 px-4 py-16 md:px-8">
        <FragmentSubnav current="telegram" />

        <section className="grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div className="space-y-6">
            <p className="inline-flex items-center gap-2 rounded-full border border-teal-200/70 bg-white/70 px-4 py-1 text-xs font-semibold tracking-wide text-teal-700 uppercase shadow-sm dark:border-teal-400/20 dark:bg-slate-950/70 dark:text-teal-200">
              <Bot className="size-4" />
              Telegram Fragment
            </p>
            <h1 className="text-4xl font-extrabold tracking-tight md:text-5xl lg:text-6xl">
              Bots that stay in sync with your product
            </h1>
            <p className="text-fd-muted-foreground max-w-xl text-lg md:text-xl">
              Durable webhooks, typed command handlers, and a full chat data model. Drop Telegram
              into your stack without hand-building the glue.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                to="/docs/telegram"
                className="rounded-lg bg-teal-600 px-6 py-3 font-semibold text-white shadow-sm transition-colors hover:bg-teal-700"
              >
                Telegram Docs
              </Link>
              <Link
                to="/docs/telegram/quickstart"
                className="rounded-lg border border-teal-200 px-6 py-3 font-semibold text-teal-700 shadow-sm transition-colors hover:bg-teal-50 dark:border-teal-400/30 dark:text-teal-200 dark:hover:bg-teal-500/10"
              >
                Quickstart
              </Link>
            </div>
            <div className="max-w-md space-y-2 pt-2">
              <p className="text-fd-muted-foreground text-xs font-semibold tracking-wide uppercase">
                Install
              </p>
              <FragnoCodeBlock
                lang="bash"
                code="npm install @fragno-dev/telegram-fragment @fragno-dev/db"
                allowCopy
                className="rounded-xl"
              />
            </div>
          </div>

          <div className="relative rounded-3xl border border-black/5 bg-white/80 p-6 shadow-xl shadow-sky-500/10 backdrop-blur dark:border-white/10 dark:bg-slate-950/70">
            <div className="absolute top-6 -right-10 h-24 w-24 rounded-full bg-teal-500/20 blur-2xl" />
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-teal-400/40 text-teal-600 dark:text-teal-300">
                <MessageSquare className="size-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                  Command console
                </h2>
                <p className="text-fd-muted-foreground text-sm">
                  Chat events to command registry to typed response
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-4">
              <div className="rounded-2xl border border-sky-200/70 bg-sky-50/80 px-4 py-3 text-sm text-slate-700 shadow-sm dark:border-sky-400/20 dark:bg-sky-500/10 dark:text-slate-100">
                <div className="text-xs font-semibold tracking-wide text-sky-700 uppercase dark:text-sky-300">
                  /ping
                </div>
                <div className="mt-1">Should we ship the release?</div>
              </div>
              <div className="ml-auto max-w-[80%] rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white shadow-sm">
                <div className="text-xs font-semibold tracking-wide text-teal-300 uppercase">
                  bot reply
                </div>
                <div className="mt-1">pong. Deployment green across all regions.</div>
              </div>
              <div className="flex items-center gap-3 rounded-2xl border border-black/5 bg-white/80 px-4 py-3 text-xs text-slate-600 dark:border-white/10 dark:bg-slate-900/70 dark:text-slate-200">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-500/15 text-teal-600 dark:text-teal-300">
                  <Zap className="size-4" />
                </span>
                <div>
                  <p className="font-semibold text-slate-800 dark:text-white">Hooks fired</p>
                  <p className="text-fd-muted-foreground">onMessageReceived + onCommandMatched</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-6 md:grid-cols-2">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="group rounded-2xl border border-black/5 bg-white/90 p-6 shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg dark:border-white/10 dark:bg-slate-950/60"
            >
              <div className="flex items-start gap-4">
                <span
                  className={`flex h-11 w-11 items-center justify-center rounded-xl border ${feature.accent}`}
                >
                  {feature.icon}
                </span>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {feature.title}
                  </h3>
                  <p className="text-fd-muted-foreground mt-1 text-sm">{feature.description}</p>
                </div>
              </div>
            </div>
          ))}
        </section>

        <section className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-teal-400/40 text-teal-600 dark:text-teal-300">
                <RouteIcon className="size-5" />
              </span>
              <div>
                <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
                  Setup blueprint
                </h2>
                <p className="text-fd-muted-foreground text-sm">
                  A focused path from webhook to bot responses.
                </p>
              </div>
            </div>

            <div className="space-y-6">
              {setupSteps.map((step) => (
                <div
                  key={step.title}
                  className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60"
                >
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {step.title}
                  </h3>
                  <p className="text-fd-muted-foreground mt-1 text-sm">{step.description}</p>
                  <div className="mt-4">
                    <FragnoCodeBlock
                      lang={step.lang}
                      code={step.code}
                      allowCopy
                      className="rounded-xl"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-500/15 text-teal-600 dark:text-teal-300">
                  <Terminal className="size-4" />
                </span>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                    Command bindings
                  </h3>
                  <p className="text-fd-muted-foreground text-sm">
                    Enable or scope commands per chat.
                  </p>
                </div>
              </div>
              <div className="mt-4">
                <FragnoCodeBlock lang="ts" code={commandSnippet} allowCopy className="rounded-xl" />
              </div>
            </div>

            <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-300">
                  <MessageSquare className="size-4" />
                </span>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                    Send a message
                  </h3>
                  <p className="text-fd-muted-foreground text-sm">
                    Use typed client hooks to respond instantly.
                  </p>
                </div>
              </div>
              <div className="mt-4">
                <FragnoCodeBlock lang="ts" code={sendSnippet} allowCopy className="rounded-xl" />
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="rounded-3xl border border-black/5 bg-white/90 p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-400/40 text-sky-600 dark:text-sky-300">
                <RouteIcon className="size-5" />
              </span>
              <div>
                <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
                  Routes at a glance
                </h2>
                <p className="text-fd-muted-foreground text-sm">
                  Everything needed to ingest updates and interact with chats.
                </p>
              </div>
            </div>
            <ul className="mt-5 grid gap-2 text-sm text-slate-700 dark:text-slate-200">
              {routes.map((route) => (
                <li key={route} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-teal-500/70" aria-hidden />
                  <span className="font-mono text-[13px]">{route}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-3xl border border-black/5 bg-white/90 p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-400/40 text-emerald-600 dark:text-emerald-300">
                <Zap className="size-5" />
              </span>
              <div>
                <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
                  Built for product ops
                </h2>
                <p className="text-fd-muted-foreground text-sm">
                  Use Telegram as an operations surface, not just a bot.
                </p>
              </div>
            </div>
            <div className="mt-5 space-y-3">
              {[
                {
                  title: "Incident response",
                  description: "Pipe alerts to Telegram and let on-call respond with commands.",
                },
                {
                  title: "Customer updates",
                  description: "Broadcast releases and route questions to support workflows.",
                },
                {
                  title: "Workflow approvals",
                  description: "Collect approvals in Telegram while persisting every decision.",
                },
              ].map((item) => (
                <div
                  key={item.title}
                  className="rounded-2xl border border-black/5 bg-slate-50 p-4 text-sm text-slate-700 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-200"
                >
                  <p className="font-semibold text-slate-900 dark:text-white">{item.title}</p>
                  <p className="text-fd-muted-foreground mt-1 text-sm">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
