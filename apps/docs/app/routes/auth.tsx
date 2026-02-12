import { ArrowRight, Database, KeyRound, Shield, Users } from "lucide-react";
import { FragnoCodeBlock } from "@/components/fragno-code-block";
import { FragmentSubnav } from "@/components/fragment-subnav";
import type { ReactNode } from "react";

export function meta() {
  return [
    { title: "Auth Fragment" },
    {
      name: "description",
      content: "Authentication fragment with user, session, and role management.",
    },
  ];
}

type Feature = {
  title: string;
  description: string;
  icon: ReactNode;
};

const features: Feature[] = [
  {
    title: "Users + sessions",
    description: "Email/password sign-up, sign-in, and sign-out flows with session cookies.",
    icon: <Users className="size-5" />,
  },
  {
    title: "Roles + admin",
    description: "Built-in user overview and role updates via fragment routes.",
    icon: <Shield className="size-5" />,
  },
  {
    title: "Database-backed",
    description: "Auth data is stored in your database with typed schemas.",
    icon: <Database className="size-5" />,
  },
];

const routeSurface = `GET    /me
POST   /sign-up
POST   /sign-in
POST   /sign-out
POST   /change-password
GET    /users
PATCH  /users/:userId/role`;

const serverSnippet = `import { createAuthFragment } from "@fragno-dev/auth";

export const authFragment = createAuthFragment(
  {
    cookieOptions: {
      secure: true,
      sameSite: "lax",
    },
  },
  {
    databaseAdapter,
    mountRoute: "/api/auth",
  },
);`;

const mountSnippet = `import { authFragment } from "@/lib/auth";

export const handlers = authFragment.handlersFor("react-router");

export const action = handlers.action;
export const loader = handlers.loader;`;

const clientSnippet = `import { createAuthFragmentClient } from "@fragno-dev/auth/react";

export const authClient = createAuthFragmentClient();`;

const hookSnippet = `const { mutate: signIn } = authClient.useSignIn();
const { mutate: signOut } = authClient.useSignOut();
const { data: me } = authClient.useMe();
const { data: users } = authClient.useUsers();`;

const useCases = [
  {
    title: "Product sign-up",
    description: "Launch email/password authentication with built-in routes and cookies.",
  },
  {
    title: "Admin user management",
    description: "List users and update roles through admin routes.",
  },
  {
    title: "Session-protected APIs",
    description: "Use the fragment to secure internal routes with session data.",
  },
];

export default function AuthPage() {
  return (
    <main className="relative min-h-screen">
      <div className="mx-auto max-w-7xl space-y-14 px-4 py-16 md:px-8">
        <FragmentSubnav current="auth" />
        <section className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div className="space-y-5">
            <h1 className="text-4xl font-extrabold tracking-tight md:text-5xl lg:text-6xl">
              Authentication Fragment
            </h1>
            <p className="text-fd-muted-foreground max-w-xl text-lg md:text-xl">
              Build sign-up, sign-in, sessions, and admin workflows without rolling your own auth
              stack.
            </p>
            <div className="max-w-md space-y-2 pt-3">
              <p className="text-fd-muted-foreground text-xs font-semibold uppercase tracking-wide">
                Install
              </p>
              <FragnoCodeBlock
                lang="bash"
                code="npm install @fragno-dev/auth @fragno-dev/db"
                allowCopy
                className="rounded-xl"
              />
            </div>
          </div>

          <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-emerald-400/30 text-emerald-600 dark:text-emerald-300">
                <KeyRound className="size-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                  Route surface
                </h2>
                <p className="text-fd-muted-foreground text-sm">
                  The core endpoints the fragment exposes.
                </p>
              </div>
            </div>
            <div className="mt-4">
              <FragnoCodeBlock lang="bash" code={routeSurface} allowCopy className="rounded-xl" />
            </div>
          </div>
        </section>

        <section className="grid gap-6 md:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-400/30 text-emerald-600 dark:text-emerald-300">
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

        <section className="space-y-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-400/30 text-emerald-600 dark:text-emerald-300">
              <KeyRound className="size-5" />
            </span>
            <div>
              <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
                Setup blueprint
              </h2>
              <p className="text-fd-muted-foreground text-sm">
                Server wiring on the left, client hooks on the right.
              </p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-6">
              <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                  Create the fragment server
                </h3>
                <p className="text-fd-muted-foreground mt-1 text-sm">
                  Configure cookie defaults and pass the database adapter.
                </p>
                <div className="mt-4">
                  <FragnoCodeBlock
                    lang="ts"
                    code={serverSnippet}
                    allowCopy
                    className="rounded-xl"
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                  Mount routes
                </h3>
                <p className="text-fd-muted-foreground mt-1 text-sm">
                  Expose auth routes in your framework adapter.
                </p>
                <div className="mt-4">
                  <FragnoCodeBlock lang="ts" code={mountSnippet} allowCopy className="rounded-xl" />
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                  Client hooks
                </h3>
                <p className="text-fd-muted-foreground mt-1 text-sm">
                  Typed hooks cover sign-in, sign-up, sign-out, and user listings.
                </p>
                <div className="mt-4">
                  <FragnoCodeBlock
                    lang="ts"
                    code={clientSnippet}
                    allowCopy
                    className="rounded-xl"
                  />
                </div>
                <div className="mt-4">
                  <FragnoCodeBlock lang="ts" code={hookSnippet} allowCopy className="rounded-xl" />
                </div>
              </div>

              <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                  Get updates
                </h3>
                <p className="text-fd-muted-foreground mt-2 text-sm">
                  The auth fragment is in active development. Join the community to shape the
                  roadmap.
                </p>
                <a
                  href="https://discord.gg/jdXZxyGCnC"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-emerald-600 hover:text-emerald-700 dark:text-emerald-300 dark:hover:text-emerald-200"
                >
                  Talk to the team
                  <ArrowRight className="size-4" />
                </a>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">Use cases</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {useCases.map((useCase) => (
              <div
                key={useCase.title}
                className="rounded-2xl border border-black/5 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-950/60"
              >
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                  {useCase.title}
                </h3>
                <p className="text-fd-muted-foreground mt-2 text-sm">{useCase.description}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
