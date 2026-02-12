import { Link } from "react-router";
import { Activity, CreditCard, Database, Route as RouteIcon } from "lucide-react";
import { FragnoCodeBlock } from "@/components/fragno-code-block";
import { FragmentSubnav } from "@/components/fragment-subnav";
import { StripeDataFlow } from "@/components/stripe-data-flow";
import type { ReactNode } from "react";

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
        successUrl: \`${"${window.location.origin}"}/success\`,
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
    <main className="relative min-h-screen">
      <div className="mx-auto max-w-7xl space-y-14 px-4 py-16 md:px-8">
        <FragmentSubnav current="stripe" />
        <section className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div className="space-y-5">
            <h1 className="text-4xl font-extrabold tracking-tight md:text-5xl lg:text-6xl">
              Stripe Billing
            </h1>
            <p className="text-fd-muted-foreground max-w-xl text-lg md:text-xl">
              Subscriptions, checkout, webhooks, and billing portal flows in one fragment.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                to="/docs/stripe"
                className="rounded-lg bg-violet-600 px-6 py-3 font-semibold text-white shadow-sm transition-colors hover:bg-violet-700"
              >
                Stripe Docs
              </Link>
            </div>
            <div className="max-w-md space-y-2 pt-3">
              <p className="text-fd-muted-foreground text-xs font-semibold uppercase tracking-wide">
                Install
              </p>
              <FragnoCodeBlock
                lang="bash"
                code="npm install @fragno-dev/stripe @fragno-dev/db"
                allowCopy
                className="rounded-xl"
              />
            </div>
          </div>

          <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-violet-400/30 text-violet-600 dark:text-violet-300">
                <CreditCard className="size-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                  Billing flow
                </h2>
                <p className="text-fd-muted-foreground text-sm">
                  A Stripe event moves through your app in minutes.
                </p>
              </div>
            </div>
            <ol className="mt-6 space-y-4">
              {flow.map((item, index) => (
                <li key={item.title} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full border border-violet-400/30 text-sm font-semibold text-violet-700 dark:text-violet-300">
                      {index + 1}
                    </span>
                    {index < flow.length - 1 && (
                      <span className="mt-2 h-6 w-px bg-slate-200 dark:bg-slate-800" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">
                      {item.title}
                    </p>
                    <p className="text-fd-muted-foreground text-sm">{item.description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="grid gap-6 md:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-violet-400/30 text-violet-600 dark:text-violet-300">
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
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-violet-400/30 text-violet-600 dark:text-violet-300">
              <CreditCard className="size-5" />
            </span>
            <div>
              <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
                Setup blueprint
              </h2>
              <p className="text-fd-muted-foreground text-sm">
                The high-signal steps, with code you can paste.
              </p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
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

            <div className="space-y-6">
              <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Use it</h3>
                <p className="text-fd-muted-foreground mt-1 text-sm">
                  Hook into upgrade/cancel flows directly in your UI.
                </p>
                <div className="mt-4">
                  <FragnoCodeBlock
                    lang="tsx"
                    code={usageSnippet}
                    allowCopy
                    className="rounded-xl"
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-black/5 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                  Query subscriptions
                </h3>
                <p className="text-fd-muted-foreground mt-1 text-sm">
                  Access subscription data on the server for dashboards or admin flows.
                </p>
                <div className="mt-4">
                  <FragnoCodeBlock
                    lang="ts"
                    code={serviceSnippet}
                    allowCopy
                    className="rounded-xl"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-8 lg:grid-cols-[1.05fr_1fr] lg:items-center">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
              We fix split brain
            </p>
            <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
              Keep Stripe and your database in sync
            </h2>
            <p className="text-fd-muted-foreground max-w-2xl text-sm">
              Split brain happens when Stripe is the source of truth but your app depends on a local
              copy of subscription state. The fragment ships the webhook handlers, schema, and
              client hooks together so you stay synchronized without re-implementing the hard parts.
            </p>
          </div>
          <div className="space-y-3">
            <StripeDataFlow mode="with-fragment" />
            <p className="text-fd-muted-foreground mt-4 text-sm">
              Events flow from Stripe → fragment handlers → your database. Your UI reads from a
              single, consistent source instead of juggling webhook races.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
