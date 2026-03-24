import { Database, KeyRound, Shield, Users } from "lucide-react";
import type { ReactNode } from "react";

import {
  FragmentEyebrow,
  FragmentHero,
  FragmentMetric,
  FragmentPageShell,
  FragmentPanel,
  FragmentSection,
} from "@/components/fragment-editorial";
import { FragmentSubnav } from "@/components/fragment-subnav";
import { FragnoCodeBlock } from "@/components/fragno-code-block";

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
    <FragmentPageShell>
      <FragmentSubnav current="auth" />

      <FragmentHero
        eyebrow={<FragmentEyebrow>Authentication</FragmentEyebrow>}
        title={<>Auth should arrive as a finished boundary, not a forever-project.</>}
        description={
          <>
            Sessions, sign-up, organizations, invitations, and active-workspace state are rarely
            just one table and a login form. The auth fragment packages those concerns into a typed
            surface so the app can focus on product logic instead of rebuilding identity plumbing.
          </>
        }
        aside={
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            <FragmentMetric
              label="Mount route"
              value="/api/auth"
              accentClass="text-[var(--editorial-muted)] text-lg md:text-2xl"
            />
            <FragmentMetric
              label="Includes"
              value="Users + orgs + roles"
              accentClass="text-[var(--editorial-muted)] text-lg md:text-2xl"
            />
            <FragmentMetric
              label="Backed by"
              value="Your database"
              accentClass="text-[var(--editorial-muted)] text-lg md:text-2xl"
            />
          </div>
        }
      >
        <div className="max-w-xl space-y-2 pt-3">
          <p className="text-[11px] font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
            Install
          </p>
          <FragnoCodeBlock
            lang="bash"
            code="npm install @fragno-dev/auth @fragno-dev/db"
            allowCopy
            syntaxTheme="editorial-triad"
            className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
          />
        </div>
      </FragmentHero>

      <FragmentSection
        eyebrow={<FragmentEyebrow>Capabilities</FragmentEyebrow>}
        title={<>The everyday auth primitives are already shaped.</>}
      >
        <div className="grid gap-5 md:grid-cols-3">
          {features.map((feature) => (
            <FragmentPanel key={feature.title} className="space-y-4">
              <div className="flex items-center gap-3 text-[var(--editorial-muted)]">
                {feature.icon}
                <h3 className="text-xl font-bold tracking-[-0.03em] text-[var(--editorial-ink)]">
                  {feature.title}
                </h3>
              </div>
              <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                {feature.description}
              </p>
            </FragmentPanel>
          ))}
        </div>
      </FragmentSection>

      <FragmentSection
        eyebrow={<FragmentEyebrow>Interface</FragmentEyebrow>}
        title={<>Auth routes are compact, but the product surface is broad.</>}
      >
        <div className="grid gap-5 lg:grid-cols-[0.72fr_1.28fr]">
          <FragmentPanel className="space-y-3">
            <div className="flex items-center gap-3 text-[var(--editorial-muted)]">
              <KeyRound className="size-5" />
              <h3 className="text-xl font-bold tracking-[-0.03em] text-[var(--editorial-ink)]">
                Route surface
              </h3>
            </div>
            <FragnoCodeBlock
              lang="bash"
              code={routeSurface}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
          <FragmentPanel className="space-y-3">
            <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
              Why it matters
            </p>
            <p className="text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
              Good auth is never only about identity. It is about product access, membership,
              workspace context, and role semantics. This fragment treats that seam as one thing to
              mount and one thing to consume from typed clients.
            </p>
          </FragmentPanel>
        </div>
      </FragmentSection>

      <FragmentSection
        eyebrow={<FragmentEyebrow>Blueprint</FragmentEyebrow>}
        title={<>Wire the server, mount the handlers, then consume typed auth hooks.</>}
      >
        <div className="grid gap-5 lg:grid-cols-3">
          <FragmentPanel className="space-y-3">
            <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
              Create the fragment
            </p>
            <FragnoCodeBlock
              lang="ts"
              code={serverSnippet}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
          <FragmentPanel className="space-y-3">
            <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
              Mount handlers
            </p>
            <FragnoCodeBlock
              lang="ts"
              code={mountSnippet}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
          <FragmentPanel className="space-y-3">
            <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
              Create client
            </p>
            <FragnoCodeBlock
              lang="ts"
              code={clientSnippet}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
        </div>
      </FragmentSection>

      <FragmentSection
        eyebrow={<FragmentEyebrow>Use it</FragmentEyebrow>}
        title={<>The client API matches the actual auth model.</>}
      >
        <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          <FragmentPanel className="space-y-3">
            <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
              Hooks
            </p>
            <FragnoCodeBlock
              lang="ts"
              code={hookSnippet}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
          <div className="grid gap-5 md:grid-cols-3 lg:grid-cols-1">
            {useCases.map((useCase) => (
              <FragmentPanel key={useCase.title} className="space-y-3">
                <p className="text-lg font-bold tracking-[-0.03em]">{useCase.title}</p>
                <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                  {useCase.description}
                </p>
              </FragmentPanel>
            ))}
          </div>
        </div>
      </FragmentSection>
    </FragmentPageShell>
  );
}
