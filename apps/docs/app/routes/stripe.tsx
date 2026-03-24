import { Activity, CreditCard, Database, Route as RouteIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  FragmentActionLink,
  FragmentEyebrow,
  FragmentHero,
  FragmentMetric,
  FragmentPageShell,
  FragmentPanel,
  FragmentSection,
} from "@/components/fragment-editorial";
import { FragmentSubnav } from "@/components/fragment-subnav";
import { FragnoCodeBlock } from "@/components/fragno-code-block";
import { StripeDataFlow } from "@/components/stripe-data-flow";

export function meta() {
  return [
    { title: "Stripe Fragment" },
    {
      name: "description",
      content:
        "Add Stripe billing with subscriptions, checkout, webhooks, and database-backed state.",
    },
  ];
}

type Feature = {
  title: string;
  description: string;
  icon: ReactNode;
};

type Step = {
  title: string;
  description: string;
  lang: "bash" | "ts";
  code: string;
};

const features: Feature[] = [
  {
    title: "Checkout + billing portal",
    description: "Create subscriptions, upgrades, and cancellations directly from your frontend.",
    icon: <RouteIcon className="size-5" />,
  },
  {
    title: "Automatic webhook sync",
    description: "Keep subscription state up to date with Stripe events and sync helpers.",
    icon: <Activity className="size-5" />,
  },
  {
    title: "Database-backed state",
    description: "The fragment stores subscription data in your own database.",
    icon: <Database className="size-5" />,
  },
];

const setupSteps: Step[] = [
  {
    title: "1. Install",
    description: "Install the fragment and the Fragno DB package.",
    lang: "bash",
    code: "npm install @fragno-dev/stripe @fragno-dev/db",
  },
  {
    title: "2. Create the fragment server",
    description: "Configure Stripe secrets and map customers to your users.",
    lang: "ts",
    code: `import { createStripeFragment } from "@fragno-dev/stripe";
import { getSession } from "@/lib/auth";
import { updateEntity } from "@/db/repo";

export const stripeFragment = createStripeFragment({
  stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,

  onStripeCustomerCreated: async (stripeCustomerId, referenceId) => {
    await updateEntity(referenceId, { stripeCustomerId });
  },

  resolveEntityFromRequest: async (context) => {
    const session = getSession(context.headers);

    return {
      referenceId: session.user.id,
      customerEmail: session.user.email,
      stripeCustomerId: session.user.stripeCustomerId || undefined,
      stripeMetadata: {},
    };
  },
});`,
  },
  {
    title: "3. Mount routes + generate schema",
    description: "Expose the Stripe handlers and generate schema migrations.",
    lang: "ts",
    code: `import { stripeFragment } from "@/lib/stripe";

export const handlers = stripeFragment.handlersFor("react-router");
export const action = handlers.action;
export const loader = handlers.loader;

// Generate schema
// npx fragno-cli db generate lib/stripe.ts --format drizzle -o db/stripe.schema.ts`,
  },
  {
    title: "4. Create a client",
    description: "Generate typed hooks for billing flows.",
    lang: "ts",
    code: `import { createStripeFragmentClient } from "@fragno-dev/stripe/react";

export const stripeClient = createStripeFragmentClient();`,
  },
];

const usageSnippet = `import { stripeClient } from "@/lib/stripe-client";

export function SubscribeButton() {
  const { mutate, loading } = stripeClient.upgradeSubscription();

  const handleSubscribe = async () => {
    const { url, redirect } = await mutate({
      body: {
        priceId: "price_123",
        successUrl: \
\`${"${window.location.origin}"}/success\`,
        cancelUrl: window.location.href,
      },
    });

    if (redirect) {
      window.location.href = url;
    }
  };

  return (
    <button onClick={handleSubscribe} disabled={loading}>
      {loading ? "Loading..." : "Subscribe"}
    </button>
  );
}`;

const serviceSnippet = `import { stripeFragment } from "@/lib/stripe";

const subscriptions = await stripeFragment.services.getSubscriptionsByReferenceId(user.id);
const subscription = await stripeFragment.services.getSubscriptionById(subscriptionId);
const byCustomer = await stripeFragment.services.getSubscriptionsByStripeCustomerId(customerId);`;

const flow = [
  {
    title: "Checkout session",
    description: "Stripe creates a session and redirects the customer.",
  },
  {
    title: "Webhook event",
    description: "The fragment syncs subscription state into your database.",
  },
  {
    title: "In-app hooks",
    description: "Use typed hooks to trigger upgrades, cancellations, or portals.",
  },
];

export default function StripePage() {
  return (
    <FragmentPageShell>
      <FragmentSubnav current="stripe" />

      <FragmentHero
        eyebrow={<FragmentEyebrow>Stripe</FragmentEyebrow>}
        title={<>Billing is a product system, not just a checkout call.</>}
        description={
          <>
            Stripe integrations usually sprawl across webhooks, checkout flows, customer mapping,
            subscription state, and frontend actions. The Stripe fragment keeps that boundary whole,
            so billing enters your app as one mountable surface instead of a trail of glue code.
          </>
        }
        aside={
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            <FragmentMetric
              label="Mount route"
              value="/api/stripe"
              accentClass="text-[var(--editorial-muted)] text-lg md:text-2xl"
            />
            <FragmentMetric
              label="Includes"
              value="Webhooks + state"
              accentClass="text-[var(--editorial-muted)] text-lg md:text-2xl"
            />
            <FragmentMetric
              label="Best for"
              value="Subscriptions"
              accentClass="text-[var(--editorial-muted)] text-lg md:text-2xl"
            />
          </div>
        }
      >
        <div className="flex flex-wrap gap-3 pt-2">
          <FragmentActionLink to="/docs/stripe">Stripe docs</FragmentActionLink>
        </div>
        <div className="max-w-xl space-y-2 pt-3">
          <p className="text-[11px] font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
            Install
          </p>
          <FragnoCodeBlock
            lang="bash"
            code="npm install @fragno-dev/stripe @fragno-dev/db"
            allowCopy
            syntaxTheme="editorial-triad"
            className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
          />
        </div>
      </FragmentHero>

      <FragmentSection
        eyebrow={<FragmentEyebrow>Flow</FragmentEyebrow>}
        title={<>A billing event should move cleanly through your stack.</>}
      >
        <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          <FragmentPanel className="space-y-4">
            <div className="flex items-center gap-3 text-[var(--editorial-muted)]">
              <CreditCard className="size-5" />
              <h3 className="text-xl font-bold tracking-[-0.03em] text-[var(--editorial-ink)]">
                Billing flow
              </h3>
            </div>
            <ol className="space-y-4">
              {flow.map((item, index) => (
                <li key={item.title} className="flex gap-4">
                  <div className="flex h-8 w-8 items-center justify-center bg-[var(--editorial-surface-low)] text-sm font-bold text-[var(--editorial-ink)] shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]">
                    {index + 1}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-[var(--editorial-ink)]">{item.title}</p>
                    <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                      {item.description}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </FragmentPanel>
          <FragmentPanel>
            <StripeDataFlow />
          </FragmentPanel>
        </div>
      </FragmentSection>

      <FragmentSection
        eyebrow={<FragmentEyebrow>Capabilities</FragmentEyebrow>}
        title={<>The common billing seams are already packaged.</>}
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
        eyebrow={<FragmentEyebrow>Blueprint</FragmentEyebrow>}
        title={<>Configure the server once, then expose typed billing actions.</>}
      >
        <div className="grid gap-5 lg:grid-cols-2">
          {setupSteps.map((step) => (
            <FragmentPanel key={step.title} className="space-y-3">
              <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
                {step.title}
              </p>
              <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                {step.description}
              </p>
              <FragnoCodeBlock
                lang={step.lang}
                code={step.code}
                allowCopy
                syntaxTheme="editorial-triad"
                className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
              />
            </FragmentPanel>
          ))}
        </div>
      </FragmentSection>

      <FragmentSection
        eyebrow={<FragmentEyebrow>Use it</FragmentEyebrow>}
        title={<>Billing logic stays typed on both sides of the boundary.</>}
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <FragmentPanel className="space-y-3">
            <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
              Frontend action
            </p>
            <FragnoCodeBlock
              lang="tsx"
              code={usageSnippet}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
          <FragmentPanel className="space-y-3">
            <p className="text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
              Server services
            </p>
            <FragnoCodeBlock
              lang="ts"
              code={serviceSnippet}
              allowCopy
              syntaxTheme="editorial-triad"
              className="bg-[var(--editorial-surface-low)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]"
            />
          </FragmentPanel>
        </div>
      </FragmentSection>
    </FragmentPageShell>
  );
}
