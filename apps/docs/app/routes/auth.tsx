import {
  ArrowRight,
  BadgeCheck,
  Building2,
  Database,
  KeyRound,
  Shield,
  UserPlus,
  Users,
} from "lucide-react";
import { FragnoCodeBlock } from "@/components/fragno-code-block";
import { FragmentSubnav } from "@/components/fragment-subnav";
import type { ReactNode } from "react";

export function meta() {
  return [
    { title: "Auth Fragment" },
    {
      name: "description",
      content: "Authentication fragment with users, sessions, organizations, and roles.",
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
    title: "Organizations + roles",
    description: "Create organizations, manage members, and assign roles with invitations.",
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
PATCH  /users/:userId/role
POST   /organizations
GET    /organizations
PATCH  /organizations/:organizationId
GET    /organizations/:organizationId/members
POST   /organizations/:organizationId/invitations
PATCH  /organizations/invitations/:invitationId
GET    /organizations/active
POST   /organizations/active`;

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
const { data: users } = authClient.useUsers();
const { data: orgs } = authClient.useOrganizations();
const { data: members } = authClient.useOrganizationMembers({
  path: { organizationId },
});
const { data: invitations } = authClient.useOrganizationInvitations({
  path: { organizationId },
});`;

const useCases = [
  {
    title: "Product sign-up",
    description: "Launch email/password authentication with built-in routes and cookies.",
  },
  {
    title: "Team onboarding",
    description: "Invite members to organizations and manage roles as teams grow.",
  },
  {
    title: "Multi-tenant workspaces",
    description: "Keep sessions and active organization context in sync for workspaces.",
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
              Build sign-up, sessions, organizations, and role-based access without rolling your own
              auth stack.
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
                  Typed hooks cover auth, users, organizations, members, and invitations.
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

        <section className="space-y-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-400/30 text-emerald-600 dark:text-emerald-300">
              <Building2 className="size-5" />
            </span>
            <div>
              <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
                Organization workflows
              </h2>
              <p className="text-fd-muted-foreground text-sm">
                Everything you need to model teams, workspaces, and access policies in one place.
              </p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="rounded-2xl border border-emerald-200/60 bg-gradient-to-br from-emerald-50/70 via-white to-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                Lifecycle at a glance
              </h3>
              <p className="text-fd-muted-foreground mt-1 text-sm">
                Organizations connect users, roles, and invitations with a single session-aware API
                surface.
              </p>
              <div className="mt-5 space-y-3">
                <div className="flex items-start gap-3 rounded-xl border border-emerald-200/60 bg-white/80 p-3 shadow-sm dark:border-white/10 dark:bg-slate-950/40">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200">
                    <Building2 className="size-4" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">
                      Create the organization
                    </p>
                    <p className="text-fd-muted-foreground text-sm">
                      Create the org, seed the first member, and start assigning roles immediately.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-xl border border-emerald-200/60 bg-white/80 p-3 shadow-sm dark:border-white/10 dark:bg-slate-950/40">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200">
                    <UserPlus className="size-4" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">
                      Invite and onboard
                    </p>
                    <p className="text-fd-muted-foreground text-sm">
                      Send invitations, accept or reject them, and keep membership in sync.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-xl border border-emerald-200/60 bg-white/80 p-3 shadow-sm dark:border-white/10 dark:bg-slate-950/40">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200">
                    <BadgeCheck className="size-4" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">
                      Manage roles and access
                    </p>
                    <p className="text-fd-muted-foreground text-sm">
                      Update member roles, remove members, and enforce permissions consistently.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-black/5 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                <div className="flex items-center gap-2">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200">
                    <Shield className="size-4" />
                  </span>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                    Active organization
                  </h3>
                </div>
                <p className="text-fd-muted-foreground mt-2 text-sm">
                  Keep workspace context on the session so clients always know which org is active.
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-700 dark:text-slate-200">
                  <span className="rounded-full border border-emerald-200/70 bg-emerald-50 px-2.5 py-1 dark:border-emerald-400/20 dark:bg-emerald-500/10">
                    /organizations/active
                  </span>
                  <span className="rounded-full border border-emerald-200/70 bg-emerald-50 px-2.5 py-1 dark:border-emerald-400/20 dark:bg-emerald-500/10">
                    session context
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-black/5 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                <div className="flex items-center gap-2">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200">
                    <Users className="size-4" />
                  </span>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                    Org hooks + insights
                  </h3>
                </div>
                <p className="text-fd-muted-foreground mt-2 text-sm">
                  Subscribe to organization, member, and invitation hooks to drive onboarding,
                  billing, and audit trails.
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-700 dark:text-slate-200">
                  <span className="rounded-full border border-black/5 bg-slate-50 px-2.5 py-1 dark:border-white/10 dark:bg-slate-900/40">
                    org lifecycle
                  </span>
                  <span className="rounded-full border border-black/5 bg-slate-50 px-2.5 py-1 dark:border-white/10 dark:bg-slate-900/40">
                    member updates
                  </span>
                  <span className="rounded-full border border-black/5 bg-slate-50 px-2.5 py-1 dark:border-white/10 dark:bg-slate-900/40">
                    invitation flow
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
