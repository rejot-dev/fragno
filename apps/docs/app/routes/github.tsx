import { Activity, Shield, Workflow } from "lucide-react";
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
import { GitHub } from "@/components/logos/github";

export function meta() {
  return [
    { title: "GitHub Fragment" },
    {
      name: "description",
      content:
        "Connect a GitHub App with typed routes for installations, repositories, and pull requests.",
    },
  ];
}

type Feature = { title: string; description: string; icon: ReactNode };

const features: Feature[] = [
  {
    title: "App auth handled",
    description:
      "JWT and installation token flows are built in, so you can focus on product logic.",
    icon: <Shield className="size-5" />,
  },
  {
    title: "Webhook-driven sync",
    description:
      "Track installations and repositories from GitHub events instead of manual polling.",
    icon: <Activity className="size-5" />,
  },
  {
    title: "Repo linking built-in",
    description: "Your users stay in control of what they share with your product.",
    icon: <Workflow className="size-5" />,
  },
];

const routeSurface = `POST /webhooks
GET  /installations
GET  /installations/:installationId/repos
POST /installations/:installationId/sync
GET  /repositories/linked
POST /repositories/link
POST /repositories/unlink
GET  /repositories/:owner/:repo/pulls
POST /repositories/:owner/:repo/pulls/:number/reviews`;

const serverSnippet = `import {
  createGitHubAppFragment,
  type GitHubAppFragmentConfig,
} from "@fragno-dev/github-app-fragment";

const config: GitHubAppFragmentConfig = {
  appId: process.env.GITHUB_APP_ID ?? "",
  appSlug: process.env.GITHUB_APP_SLUG ?? "",
  privateKeyPem: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
  webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? "",
};

export const githubFragment = createGitHubAppFragment(config, {
  databaseAdapter,
  mountRoute: "/api/github",
});`;

const clientSnippet = `import { createGitHubAppFragmentClient } from "@fragno-dev/github-app-fragment/react";

const github = createGitHubAppFragmentClient({ baseUrl: "/api/github" });

const syncInstallation = github.useSyncInstallation();`;

const usageSnippet = `await syncInstallation.mutate({
  path: { installationId: "12345" },
});

await fetch("/api/github/repositories/acme/docs/pulls/42/reviews", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ event: "COMMENT", body: "Looks good." }),
});`;

const webhookSnippet = `const githubFragment = createGitHubAppFragment(
  {
    appId: process.env.GITHUB_APP_ID ?? "",
    appSlug: process.env.GITHUB_APP_SLUG ?? "",
    privateKeyPem: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
    webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? "",
    webhook: (register) => {
      register("installation.deleted", async (event, idempotencyKey) => {
        const installationId = event.payload.installation?.id;
        if (!installationId) return;
        await revokeWorkspaceGitHubAccess(installationId, idempotencyKey);
      });

      register(["installation_repositories.added", "installation_repositories.removed"], async (event) => {
        await updateProjectRepositoryAccess({
          installationId: event.payload.installation.id,
          eventName: event.name,
        });
      });
    },
  },
  { databaseAdapter, mountRoute: "/api/github" },
);`;

export default function GitHubPage() {
  return (
    <FragmentPageShell>
      <FragmentSubnav current="github" />

      <FragmentHero
        eyebrow={
          <FragmentEyebrow colorClass="text-[var(--editorial-muted)]">03 // GitHub</FragmentEyebrow>
        }
        title={<>The GitHub app runtime</>}
        description={
          <>
            The GitHub fragment handles app auth, webhook ingestion, installation sync, and
            repository actions so you can build product logic on top.
          </>
        }
        aside={
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            <FragmentMetric
              label="Own the sync"
              value="Installations + repos"
              accentClass="text-[var(--editorial-muted)] text-lg md:text-2xl"
            />
            <FragmentMetric
              label="Best for"
              value="Repo-aware products"
              accentClass="text-[var(--editorial-muted)] text-lg md:text-2xl"
            />
          </div>
        }
      >
        <div className="max-w-xl space-y-2 pt-2">
          <p className="text-[11px] font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
            Install
          </p>
          <FragnoCodeBlock
            lang="bash"
            code="npm install @fragno-dev/github-app-fragment @fragno-dev/db"
            allowCopy
            syntaxTheme="editorial-triad"
            className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
          />
        </div>
      </FragmentHero>

      <FragmentSection
        eyebrow={
          <FragmentEyebrow colorClass="text-[var(--editorial-muted)]">Capabilities</FragmentEyebrow>
        }
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
        eyebrow={
          <FragmentEyebrow colorClass="text-[var(--editorial-muted)]">Interface</FragmentEyebrow>
        }
        description={
          <>
            Typed routes cover the core primitives: installations, linked repositories, sync
            actions, and pull-request operations.
          </>
        }
      >
        <div className="grid gap-5 lg:grid-cols-[0.74fr_1.26fr]">
          <FragmentPanel className="space-y-3">
            <div className="flex items-center gap-3">
              <GitHub className="size-5 text-[var(--editorial-muted)]" />
              <h3 className="text-xl font-bold tracking-[-0.03em]">Route surface</h3>
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
              If your product touches source code, reviews, CI, or developer onboarding, GitHub is
              core infrastructure. This fragment gives you a stable baseline without requiring deep
              expertise in GitHub App auth and webhook orchestration first.
            </p>
          </FragmentPanel>
        </div>
      </FragmentSection>

      <FragmentSection
        eyebrow={
          <FragmentEyebrow colorClass="text-[var(--editorial-muted)]">Blueprint</FragmentEyebrow>
        }
        title={<>Add the app once, then layer product logic on top.</>}
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <FragmentPanel className="space-y-3">
            <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
              Create the server
            </p>
            <FragnoCodeBlock
              lang="ts"
              code={serverSnippet}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
          <div className="space-y-5">
            <FragmentPanel className="space-y-3">
              <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
                Create a client
              </p>
              <FragnoCodeBlock
                lang="ts"
                code={clientSnippet}
                allowCopy
                syntaxTheme="editorial-triad"
                className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
              />
            </FragmentPanel>
            <FragmentPanel className="space-y-3">
              <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
                Use it
              </p>
              <FragnoCodeBlock
                lang="ts"
                code={usageSnippet}
                allowCopy
                syntaxTheme="editorial-triad"
                className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
              />
            </FragmentPanel>
          </div>
        </div>
      </FragmentSection>

      <FragmentSection
        eyebrow={
          <FragmentEyebrow colorClass="text-[var(--editorial-muted)]">Outcome</FragmentEyebrow>
        }
        title={<>Ship GitHub-aware features without rebuilding the platform layer.</>}
      >
        <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <FragmentPanel className="space-y-3">
            <div className="flex items-center gap-2">
              <Activity className="size-4 text-[var(--editorial-muted)]" />
              <p className="text-lg font-bold tracking-[-0.03em]">Webhook ingestion</p>
            </div>
            <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
              Register webhook listeners directly in fragment config with typed event payloads and
              idempotency keys.
            </p>
            <FragnoCodeBlock
              lang="ts"
              code={webhookSnippet}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
          <div className="grid gap-5 md:grid-cols-3 lg:grid-cols-1">
            <FragmentPanel className="space-y-3">
              <p className="text-lg font-bold tracking-[-0.03em]">Onboarding</p>
              <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                Sync installations and available repos fast.
              </p>
            </FragmentPanel>
            <FragmentPanel className="space-y-3">
              <p className="text-lg font-bold tracking-[-0.03em]">Automation</p>
              <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                React to installs and repo changes from webhooks.
              </p>
            </FragmentPanel>
            <FragmentPanel className="space-y-3">
              <p className="text-lg font-bold tracking-[-0.03em]">Reviews</p>
              <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                Trigger pull-request actions from typed, product-owned routes.
              </p>
            </FragmentPanel>
          </div>
        </div>
      </FragmentSection>
    </FragmentPageShell>
  );
}
