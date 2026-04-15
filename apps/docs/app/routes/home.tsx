import { Form, Link, useActionData, useNavigation } from "react-router";

import { Turnstile } from "@marsidev/react-turnstile";

import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import { getMailingListDurableObject } from "@/cloudflare/cloudflare-utils";
import { validateTurnstileToken } from "@/cloudflare/turnstile";
import { BackofficeScreenshotFigure } from "@/components/backoffice-screenshot-figure";
import DatabaseSupport from "@/components/database-support";
import { EssayHeader, TabbedCodeFigure } from "@/components/essay-components";
import { FragnoCodeBlock } from "@/components/fragno-code-block";
import Frameworks from "@/components/frameworks";
import { Cake } from "@/components/logos/cakes";

import type { Route } from "./+types/home";
import { AccentText, PerspectiveFocus } from "./home/essay-primitives";
import { PerspectiveControls } from "./home/perspective-controls";
import { dataLayerTabs, mountSnippet, showcaseTabs } from "./home/snippets";
import { defaultPerspective } from "./home/types";
import type {
  HomeActionData,
  NewsletterActionData,
  PerspectiveActionData,
  PerspectiveAudience,
  PerspectiveTime,
} from "./home/types";

export function meta() {
  return [
    { title: "Fragno: Full-Stack libraries" },
    {
      name: "description",
      content:
        "Fragno lets authors build portable full-stack fragments and lets users integrate them with routes, hooks, and optional database schemas included.",
    },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(CloudflareContext);
  return {
    turnstileSitekey: env.TURNSTILE_SITEKEY,
  };
}

function parsePerspectiveTime(value: FormDataEntryValue | null): PerspectiveTime | null {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  if (value === "1") {
    return "low";
  }
  if (value === "2") {
    return "medium";
  }
  if (value === "3") {
    return "high";
  }
  return null;
}

function parseAudience(value: FormDataEntryValue | null): PerspectiveAudience {
  if (value === "authors" || value === "users" || value === "both") {
    return value;
  }
  return defaultPerspective.audience;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(CloudflareContext);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "perspective") {
    const time = parsePerspectiveTime(formData.get("time") ?? formData.get("timeRange"));
    return {
      intent: "perspective",
      perspective: {
        audience: parseAudience(formData.get("audience")),
        time: time ?? defaultPerspective.time,
      },
    } satisfies PerspectiveActionData;
  }

  const email = formData.get("email");
  if (!email || typeof email !== "string") {
    return {
      intent: "newsletter",
      success: false,
      message: "Email is required",
    } satisfies NewsletterActionData;
  }

  const turnstileToken = formData.get("cf-turnstile-response");
  if (!turnstileToken || typeof turnstileToken !== "string") {
    return {
      intent: "newsletter",
      success: false,
      message: "Turnstile token is required",
    } satisfies NewsletterActionData;
  }

  const turnstileResult = await validateTurnstileToken(env.TURNSTILE_SECRET_KEY, turnstileToken);
  if (!turnstileResult.success) {
    return {
      intent: "newsletter",
      success: false,
      message: "Turnstile validation failed",
    } satisfies NewsletterActionData;
  }

  try {
    const mailingListDo = getMailingListDurableObject(context);
    await mailingListDo.subscribe(email);
    return {
      intent: "newsletter",
      success: true,
      message: "Successfully subscribed!",
    } satisfies NewsletterActionData;
  } catch (error) {
    console.error("Mailing list subscription error:", error);
    return {
      intent: "newsletter",
      success: false,
      message: "Failed to subscribe. Please try again.",
    } satisfies NewsletterActionData;
  }
}

export default function HomePage({ loaderData }: Route.ComponentProps) {
  const { turnstileSitekey } = loaderData;
  const actionData = useActionData<HomeActionData | undefined>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const newsletterActionData = actionData?.intent === "newsletter" ? actionData : undefined;

  return (
    <main className="relative mx-auto w-full max-w-7xl px-4 pt-12 pb-20 sm:px-6 md:pt-18 md:pb-28 lg:px-8">
      <article className="relative mx-auto w-full max-w-4xl">
        <div className="grid items-start gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,224px)]">
          <div>
            <EssayHeader
              volumeLine="Volume 01 // Vertical Encapsulation"
              title="Fragno: full-stack encapsulation"
              author="Wilco Kruijer"
              authorMeta="ReJot Founder"
            />
          </div>
          <aside className="pt-2 md:pt-10">
            <Cake variant="cake-full" className="mx-auto h-auto max-w-56" />
          </aside>
        </div>
        <p className="mb-6 max-w-4xl text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
          <AccentText>Ensloppification</AccentText> is what happens when you let AI generate code
          without strong abstractions. By designing vertical slices of functionality, agents can
          work on many modules concurrently.
        </p>
        <p className="mb-6 max-w-4xl text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
          Libraries are the best form of abstraction we have because they provide{" "}
          <AccentText color="secondary">encapsulation</AccentText>. But libraries are limited.
          They're only one layer of the slice: frontend or backend. Not to mention the data layer.{" "}
          <em>Fragno</em> is changing that by providing the primitives to build{" "}
          <AccentText color="tertiary">full-stack libraries</AccentText>.
        </p>
        <p className="mb-6 max-w-4xl text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
          But before I explain that, tell me what you'd like to learn:
        </p>
        <PerspectiveControls>
          <section className="mb-20 max-w-4xl space-y-8">
            <PerspectiveFocus audience="both" minimumTime="low">
              <h3 className="mb-8 text-base font-bold tracking-[0.14em] text-(--editorial-ink) uppercase">
                What is a full-stack library made of?
              </h3>
              <div className="text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                <ul className="my-6 ml-5 list-disc">
                  <li>
                    <AccentText color="primary" mark>
                      Server-side API routes
                    </AccentText>
                    <PerspectiveFocus
                      audience="both"
                      minimumTime="high"
                      className="inline"
                      as="span"
                    >
                      <span className="ml-2 text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                        - Handle secure operations, API keys, and network orchestration close to the
                        backend.
                      </span>
                    </PerspectiveFocus>
                  </li>
                  <li>
                    <AccentText color="secondary" mark>
                      Client-side reactive hooks
                    </AccentText>
                    <PerspectiveFocus
                      audience="both"
                      minimumTime="high"
                      className="inline"
                      as="span"
                    >
                      <span className="ml-2 text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                        - Expose stateful UI primitives that keep the integration ergonomic in the
                        app shell.
                      </span>
                    </PerspectiveFocus>
                  </li>
                  <li>
                    <AccentText color="tertiary" mark>
                      A database schema
                    </AccentText>
                    <PerspectiveFocus
                      audience="both"
                      minimumTime="high"
                      className="inline"
                      as="span"
                    >
                      <span className="ml-2 text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                        - Persist durable feature data so behavior survives sessions and
                        deployments.
                      </span>
                    </PerspectiveFocus>
                  </li>
                </ul>
              </div>
            </PerspectiveFocus>

            <PerspectiveFocus audience="authors" minimumTime="low">
              <p className="mb-6 leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                These three components make it so that a library can do much more: it can now
                dictate the entire user experience, a real vertical slice. This gives the author the
                opportunity to embed <AccentText colored>taste</AccentText> into the library.
              </p>
              <p className="leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                Compare this to traditional libraries that only provide backend functions. The
                integrator still needs to create routes, define hooks, wire them up, and store data
                if needed.
              </p>
            </PerspectiveFocus>

            <PerspectiveFocus audience="both" minimumTime="medium">
              <p className="mb-6 leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                Take Vercel's{" "}
                <code className="rounded-sm bg-(--editorial-surface-low) p-1 font-mono">aisdk</code>
                , a clear <strong>example</strong> of a library that has to span both the frontend
                and the backend. The user interaction on the frontend is the heart of the
                experience, while the backend holds API keys and handles function calling. Contrast
                that to the
                <code className="rounded-sm bg-(--editorial-surface-low) p-1 font-mono">
                  openai
                </code>{" "}
                library, which only provides the backend functionality and leaves the user to do the
                rest.
              </p>
              <p className="leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                But even the{" "}
                <code className="rounded-sm bg-(--editorial-surface-low) p-1 font-mono">aisdk</code>{" "}
                library is limited. It provides backend and frontend, but does not include the data
                layer. As such, it doesn't provide a way to store conversations, or have persistent
                LLM memory.
              </p>
            </PerspectiveFocus>

            <PerspectiveFocus audience="both" minimumTime="high">
              <p className="leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                Fragno proposes a different unit of composition: the{" "}
                <strong>
                  <AccentText>Fragment</AccentText>
                </strong>
                . A Fragment is a portable full-stack library slice that carries its own transport
                surface, optional schema, and client integration. Instead of teaching the developer
                to rebuild the same feature boundary in three places, it treats that boundary as one
                authored object.
              </p>
            </PerspectiveFocus>
          </section>

          <section className="mb-24 max-w-4xl space-y-8">
            <PerspectiveFocus audience="both" minimumTime="low">
              <div className="space-y-4">
                <div className="text-base font-bold tracking-[0.14em] uppercase">
                  What can be built with Fragno?
                </div>
                <p className="text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                  Well, anything. But these are some examples from the Fragno ecosystem.
                </p>
              </div>
            </PerspectiveFocus>
            <div className="grid gap-4 md:grid-cols-3">
              <PerspectiveFocus audience="both" minimumTime="low">
                <article className="flex h-full flex-col space-y-3 bg-[var(--editorial-surface-low)] p-5">
                  <h3 className="text-base font-bold tracking-[0.08em] text-[var(--editorial-primary)] uppercase">
                    Pi Agents
                  </h3>
                  <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                    Pi is the minimal agent runtime. With our fragment, you get durable agent
                    sessions with easy tool calling and session management from the frontend.
                  </p>
                  <Link
                    to="/fragments/pi"
                    className="mt-auto inline-flex pt-2 text-xs tracking-[0.08em] text-[color-mix(in_srgb,var(--editorial-ink)_55%,white)] uppercase transition-colors hover:text-[var(--editorial-primary)]"
                  >
                    View fragment
                  </Link>
                </article>
              </PerspectiveFocus>
              <PerspectiveFocus audience="both" minimumTime="low">
                <article className="flex h-full flex-col space-y-3 bg-[var(--editorial-surface-low)] p-5">
                  <h3 className="text-base font-bold tracking-[0.08em] text-[var(--editorial-secondary)] uppercase">
                    Forms
                  </h3>
                  <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                    Create forms using the form builder, and track submissions from your own
                    backoffice or database.
                  </p>
                  <Link
                    to="/fragments/forms"
                    className="mt-auto inline-flex pt-2 text-xs tracking-[0.08em] text-[color-mix(in_srgb,var(--editorial-ink)_55%,white)] uppercase transition-colors hover:text-[var(--editorial-secondary)]"
                  >
                    View fragment
                  </Link>
                </article>
              </PerspectiveFocus>
              <PerspectiveFocus audience="both" minimumTime="low">
                <article className="flex h-full flex-col space-y-3 bg-[var(--editorial-surface-low)] p-5">
                  <h3 className="text-base font-bold tracking-[0.08em] text-[var(--editorial-tertiary)] uppercase">
                    Workflows
                  </h3>
                  <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                    Package long-running orchestration with routes, durable state, and client
                    controls together, so workflow behavior stays consistent across frameworks.
                  </p>
                  <Link
                    to="/fragments/workflows"
                    className="mt-auto inline-flex pt-2 text-xs tracking-[0.08em] text-[color-mix(in_srgb,var(--editorial-ink)_55%,white)] uppercase transition-colors hover:text-[var(--editorial-tertiary)]"
                  >
                    View fragment
                  </Link>
                </article>
              </PerspectiveFocus>
            </div>
            <PerspectiveFocus audience="users" minimumTime="low">
              <div>
                <p className="mb-6 leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                  But that is not all, we have fragments for:{" "}
                  <Link
                    to="/fragments/stripe"
                    className="underline decoration-red-500 decoration-2 underline-offset-4"
                  >
                    Stripe Billing
                  </Link>
                  ,{" "}
                  <Link
                    to="/fragments/telegram"
                    className="underline decoration-blue-500 decoration-2 underline-offset-4"
                  >
                    Telegram Bots
                  </Link>
                  ,{" "}
                  <Link
                    to="/fragments/resend"
                    className="underline decoration-yellow-500 decoration-2 underline-offset-4"
                  >
                    Resend Email
                  </Link>
                  ,{" "}
                  <Link
                    to="/fragments/github"
                    className="underline decoration-red-500 decoration-2 underline-offset-4"
                  >
                    GitHub Apps
                  </Link>
                  , and{" "}
                  <Link
                    to="/fragments/upload"
                    className="underline decoration-blue-500 decoration-2 underline-offset-4"
                  >
                    S3 Uploads
                  </Link>
                  .
                </p>
                <Link
                  to="/fragments"
                  className="inline-flex text-sm tracking-[0.08em] text-[color-mix(in_srgb,var(--editorial-ink)_62%,white)] uppercase transition-colors hover:text-[var(--editorial-secondary)]"
                >
                  View all fragments
                </Link>
              </div>
            </PerspectiveFocus>
          </section>

          <PerspectiveFocus audience="both" minimumTime="low">
            <div className="mb-6 text-base font-bold tracking-[0.14em] uppercase">
              How does it work?
            </div>
            <p className="mb-6 leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
              Fragno is a full set of primitives: it contains handlers for all popular full-stack
              frameworks, as well as database integrations for popular ORMs and SQL databases.
            </p>
          </PerspectiveFocus>

          <PerspectiveFocus audience="both" minimumTime="medium">
            <p className="my-6 leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
              Below you'll find some examples of how fragments are constructed and used in
              production.
            </p>
            <TabbedCodeFigure
              tabs={showcaseTabs}
              figcaption="Fig. Production Fragno fragments in the wild: Pi agent sessions, Forms on Durable Objects, and Telegram bots."
              ariaLabel="Fragment examples"
            />
          </PerspectiveFocus>

          <PerspectiveFocus audience="users" minimumTime="low">
            <p className="mb-6 leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
              For users, integration should be as frictionless as possible. For a library that spans
              the backend and frontend, the following is enough:
            </p>
            <figure className="mb-12 space-y-6">
              <div className="overflow-hidden bg-[color-mix(in_srgb,var(--editorial-surface)_84%,transparent)] shadow-[0_24px_48px_rgb(15_23_42/0.08)] backdrop-blur-[12px] dark:shadow-[0_24px_48px_rgb(2_6_23_/_0.28)]">
                <div className="p-6 md:p-10">
                  <FragnoCodeBlock
                    lang="ts"
                    code={mountSnippet}
                    syntaxTheme="editorial-triad"
                    className="bg-[color-mix(in_srgb,var(--editorial-surface-low)_88%,var(--editorial-ink)_4%)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] dark:bg-[var(--editorial-surface-low)]!"
                    allowCopy
                  />
                </div>
              </div>
              <figcaption className="max-w-4xl text-base font-medium text-(--editorial-muted)">
                Fig. Mounting a fragment, the combination of loader and action makes sure all HTTP
                verbs are covered.
              </figcaption>
            </figure>
            <p className="mb-6 leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
              Fragments that use the optional database layer require slightly more boilerplate. By
              default, Fragno will use a local SQLite file to store the data. However, you can use
              any SQL database by providing a{" "}
              <AccentText color="secondary">database adapter</AccentText>.
            </p>
            <PerspectiveFocus audience="users" minimumTime="medium">
              <p className="mb-6 leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                Users decide how they want to integrate. They can use Fragno directly to migrate
                their database, or use the Fragno CLI to generate a schema in their preferred ORM.
              </p>
            </PerspectiveFocus>
          </PerspectiveFocus>
          <section className="mb-24 max-w-4xl space-y-8">
            <PerspectiveFocus audience="both" minimumTime="low">
              <div className="space-y-3">
                <div className="text-base font-bold tracking-[0.14em] uppercase">
                  Framework support
                </div>
                <p className="text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                  Mount the same fragment across modern full-stack frameworks with shared server and
                  client contracts.
                </p>
              </div>
            </PerspectiveFocus>
            <PerspectiveFocus audience="both" minimumTime="low">
              <figure className="space-y-6">
                <Frameworks variant="editorial" className="max-w-none" />
                <figcaption className="max-w-4xl text-base font-medium text-(--editorial-muted)">
                  Fig. Framework portability: web-standard objects are used to enable portability
                  across frameworks.
                </figcaption>
              </figure>
            </PerspectiveFocus>
          </section>

          <section className="mb-24 max-w-4xl space-y-8">
            <PerspectiveFocus audience="authors" minimumTime="low">
              <div className="space-y-4">
                <div className="text-base font-bold tracking-[0.14em] text-(--editorial-primary) uppercase">
                  For authors
                </div>
                <h2 className="text-3xl leading-[1.05] font-bold tracking-[-0.03em] md:text-5xl">
                  Authoring libraries on top of Fragno
                </h2>
                <p className="text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                  Fragno takes inspiration from industry-leading frameworks such as Hono to provide
                  features typically expected from a backend router framework.
                </p>
              </div>
            </PerspectiveFocus>

            <div className="grid gap-4 md:grid-cols-2">
              <article className="space-y-2 bg-[var(--editorial-surface-low)] p-5">
                <PerspectiveFocus audience="authors" minimumTime="low">
                  <h3 className="text-base font-bold tracking-[0.08em] text-[var(--editorial-primary)] uppercase">
                    End-to-end type safety
                  </h3>
                </PerspectiveFocus>
                <PerspectiveFocus audience="authors" minimumTime="high">
                  <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                    Keep input, output, client hooks, and database schema typed from route handlers
                    to UI usage.
                  </p>
                </PerspectiveFocus>
              </article>
              <article className="space-y-2 bg-[var(--editorial-surface-low)] p-5">
                <PerspectiveFocus audience="authors" minimumTime="low">
                  <h3 className="text-base font-bold tracking-[0.08em] text-[var(--editorial-secondary)] uppercase">
                    Frontend state management
                  </h3>
                </PerspectiveFocus>
                <PerspectiveFocus audience="authors" minimumTime="high">
                  <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                    Compose reactive stores and invalidation behavior as part of your library so
                    users get ergonomic state. Based on Nano Stores.
                  </p>
                </PerspectiveFocus>
              </article>
              <article className="space-y-2 bg-[var(--editorial-surface-low)] p-5">
                <PerspectiveFocus audience="authors" minimumTime="low">
                  <h3 className="text-base font-bold tracking-[0.08em] text-[var(--editorial-tertiary)] uppercase">
                    Streaming support
                  </h3>
                </PerspectiveFocus>
                <PerspectiveFocus audience="authors" minimumTime="high">
                  <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                    Model long-running and incremental responses with NDJSON streams while
                    preserving typed client-side consumption.
                  </p>
                </PerspectiveFocus>
              </article>
              <article className="space-y-2 bg-[var(--editorial-surface-low)] p-5">
                <PerspectiveFocus audience="authors" minimumTime="low">
                  <h3 className="text-base font-bold tracking-[0.08em] text-[var(--editorial-primary)] uppercase">
                    Middleware support
                  </h3>
                </PerspectiveFocus>
                <PerspectiveFocus audience="authors" minimumTime="high">
                  <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                    Let integrators add auth and cross-cutting behavior while preserving your
                    fragment contract and runtime semantics.
                  </p>
                </PerspectiveFocus>
              </article>
            </div>
          </section>

          <section className="mb-12 max-w-4xl space-y-6">
            <PerspectiveFocus audience="both" minimumTime="low">
              <div className="mb-6 font-bold tracking-[0.14em] uppercase">
                What does the data layer look like?
              </div>
              <p className="mb-6 leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                Letting third-party libraries write to an app's database is a{" "}
                <AccentText color="tertiary" colored>
                  delicate thing
                </AccentText>
                . Fragno's data layer is very opinionated. This makes it slightly more complicated
                for authors but gives users the safety they need.
              </p>
              <p className="mb-6 leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                Things that are{" "}
                <AccentText color="primary" mark>
                  not supported
                </AccentText>
                :
                <ul className="my-6 ml-5 list-disc text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                  <li>
                    <strong>Interactive transactions</strong>
                    <PerspectiveFocus
                      audience="both"
                      minimumTime="high"
                      className="inline"
                      as="span"
                    >
                      <span className="ml-2 text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                        - Long-lived, interactive transactions can hold locks unpredictably in
                        user-owned environments, so Fragno has two-phased transactions with
                        optimistic concurrency control instead.
                      </span>
                    </PerspectiveFocus>
                  </li>
                  <li>
                    <strong>Arbitrary joins</strong>
                    <PerspectiveFocus
                      audience="both"
                      minimumTime="high"
                      className="inline"
                      as="span"
                    >
                      <span className="ml-2 text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                        - Arbitrary joins make query performance characteristics unpredictable, so
                        Fragno only supports simple left joins.
                      </span>
                    </PerspectiveFocus>
                  </li>
                </ul>
              </p>
            </PerspectiveFocus>

            <PerspectiveFocus audience="authors" minimumTime="medium">
              <p className="leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                In some way, Fragno is the most opinionated ORM. This is necessary to provide
                safety, consistency, and compatibility with several ORMs and databases. These are
                some features that Fragno <em>does</em> support:
              </p>
              <ul className="my-6 ml-5 list-disc text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                <li>
                  <AccentText color="primary" mark>
                    Atomicity
                  </AccentText>
                  <PerspectiveFocus
                    audience="authors"
                    minimumTime="high"
                    className="inline"
                    as="span"
                  >
                    <span className="ml-2 text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                      - Reads and writes run as one retryable unit using optimistic concurrency
                      checks instead of lock-heavy interactive transactions.
                    </span>
                  </PerspectiveFocus>
                </li>
                <li>
                  <AccentText color="secondary" mark>
                    Durable Hooks
                  </AccentText>
                  <PerspectiveFocus
                    audience="authors"
                    minimumTime="high"
                    className="inline"
                    as="span"
                  >
                    <span className="ml-2 text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                      - Side effects are persisted in-transaction and dispatched after commit with
                      retries and scheduled execution support. This makes interactions with
                      third-party services and webhook ingestion from external systems reliable.
                    </span>
                  </PerspectiveFocus>
                </li>
                <li>
                  <AccentText color="tertiary" mark>
                    Cursor-based pagination
                  </AccentText>
                  <PerspectiveFocus
                    audience="authors"
                    minimumTime="high"
                    className="inline"
                    as="span"
                  >
                    <span className="ml-2 text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                      - List endpoints page through stable index cursors, keeping large datasets
                      efficient without offset drift. This works great with client-side state
                      management. Pages are kept in memory to make pagination feel seamless.
                    </span>
                  </PerspectiveFocus>
                </li>
                <li>
                  <AccentText color="primary" mark>
                    Testing with a real database
                  </AccentText>
                  <PerspectiveFocus
                    audience="authors"
                    minimumTime="high"
                    className="inline"
                    as="span"
                  >
                    <span className="ml-2 text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                      - Fragment tests run against real adapters so schema behavior, migrations, and
                      hooks are validated end-to-end.
                    </span>
                  </PerspectiveFocus>
                </li>
              </ul>
            </PerspectiveFocus>
            <PerspectiveFocus audience="authors" minimumTime="high">
              <TabbedCodeFigure
                tabs={dataLayerTabs}
                figcaption="Fig. Fragno's data layer: schema definitions, OCC transactions, and durable hooks for reliable side effects."
                ariaLabel="Data layer examples"
              />
            </PerspectiveFocus>
            <PerspectiveFocus audience="both" minimumTime="low">
              <div className="space-y-3">
                <div className="text-base font-bold tracking-[0.14em] uppercase">
                  Database &amp; ORM support
                </div>
                <p className="text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                  Fragments that use the data layer work with the ORMs and databases your app
                  already relies on.
                </p>
              </div>
            </PerspectiveFocus>
            <PerspectiveFocus audience="both" minimumTime="low">
              <figure className="space-y-6">
                <DatabaseSupport />
                <figcaption className="max-w-4xl text-base font-medium text-(--editorial-muted)">
                  Fig. Database portability: fragments declare a schema once; the user picks which
                  ORM and engine runs it.
                </figcaption>
              </figure>
            </PerspectiveFocus>

            <PerspectiveFocus audience="both" minimumTime="low">
              <div className="mb-8 space-y-4">
                <div className="text-base font-bold tracking-[0.14em] text-(--editorial-tertiary) uppercase">
                  Conclusion
                </div>
                <h2 className="text-3xl leading-[1.05] font-bold tracking-[-0.03em] md:text-5xl">
                  Why all of this matters
                </h2>
              </div>
              <p className="mb-6 leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                Before Fragno, libraries did the bare minimum.
              </p>
              <p className="mb-6 leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                Now, developers of platforms such as Stripe, Telegram, and Resend can build
                opinionated, tasteful {""}
                <AccentText color="primary">integration libraries</AccentText> that are not just
                wrappers around the API. The developers that know the platform best can ship
                libraries that{" "}
                <AccentText color="secondary">own the entire integration surface</AccentText>:
                webhook ingestion, state persistence, and surfacing information to the end user.
              </p>
            </PerspectiveFocus>
          </section>

          <section className="mb-24 max-w-4xl space-y-8">
            <PerspectiveFocus audience="both" minimumTime="low">
              <div className="space-y-4">
                <div className="text-base font-bold tracking-[0.14em] text-(--editorial-primary) uppercase">
                  Get started
                </div>
                <h2 className="text-3xl leading-[1.05] font-bold tracking-[-0.03em] md:text-5xl">
                  Start building using agent skills
                </h2>
                <p className="text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                  Fragno ships Agent Skills that teach your AI coding assistant how to integrate or
                  author fragments. Install a skill once and your agent knows the conventions, APIs,
                  and best practices.
                </p>
              </div>
            </PerspectiveFocus>

            <div className="grid gap-4 md:grid-cols-2">
              <PerspectiveFocus audience="users" minimumTime="low">
                <article className="flex h-full flex-col space-y-4 bg-(--editorial-surface-low) p-6">
                  <h3 className="text-base font-bold tracking-[0.08em] text-(--editorial-secondary) uppercase">
                    For users
                  </h3>
                  <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                    Integrate existing fragments into your app. The skill includes a list of
                    first-party fragments to make installing them easy.
                  </p>
                  <div className="mt-auto pt-2">
                    <FragnoCodeBlock
                      lang="bash"
                      code={`npx skills add https://github.com/rejot-dev/fragno --skill fragno`}
                      syntaxTheme="editorial-triad"
                      className="bg-[color-mix(in_srgb,var(--editorial-surface-low)_88%,var(--editorial-ink)_4%)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] dark:bg-[var(--editorial-surface-low)]!"
                      allowCopy
                    />
                  </div>
                </article>
              </PerspectiveFocus>

              <PerspectiveFocus audience="authors" minimumTime="low">
                <article className="flex h-full flex-col space-y-4 bg-(--editorial-surface-low) p-6">
                  <h3 className="text-base font-bold tracking-[0.08em] text-(--editorial-tertiary) uppercase">
                    For authors
                  </h3>
                  <p className="text-sm leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_72%,white)]">
                    Build your own fragments. The skill teaches your agent how to scaffold a
                    package, define routes and hooks, set up code-splitting, and export framework
                    clients.
                  </p>
                  <div className="mt-auto pt-2">
                    <FragnoCodeBlock
                      lang="bash"
                      code={`npx skills add https://github.com/rejot-dev/fragno --skill fragno-author`}
                      syntaxTheme="editorial-triad"
                      className="bg-[color-mix(in_srgb,var(--editorial-surface-low)_88%,var(--editorial-ink)_4%)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] dark:bg-[var(--editorial-surface-low)]!"
                      allowCopy
                    />
                  </div>
                </article>
              </PerspectiveFocus>
            </div>
          </section>

          <section className="mb-24 max-w-4xl space-y-8">
            <PerspectiveFocus audience="both" minimumTime="low">
              <div className="space-y-4">
                <div className="text-base font-bold tracking-[0.14em] text-(--editorial-secondary) uppercase">
                  What we built
                </div>
                <h2 className="text-3xl leading-[1.05] font-bold tracking-[-0.03em] md:text-5xl">
                  Our Fragno Claw-like agent
                </h2>
                <p className="text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                  This site and our internal Claw-like agent tooling run on the same fragment
                  primitives outlined on this page. We believe that the only way to build truly good
                  software is by dogfooding it every day.
                </p>
                <p className="mt-6 leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                  Stay tuned for more updates on our "Claw".
                </p>
              </div>
            </PerspectiveFocus>
            <PerspectiveFocus audience="both" minimumTime="low">
              <BackofficeScreenshotFigure
                screenshotUrl={{
                  light: "/backoffice-resend-light.jpg",
                  dark: "/backoffice-resend-dark.jpg",
                }}
                caption="Fig. First-party fragments (pictured: Resend) in our own Claw backoffice."
              />
            </PerspectiveFocus>
          </section>

          <section className="mb-12 max-w-4xl space-y-10">
            <div className="space-y-4">
              <PerspectiveFocus audience="both" minimumTime="low">
                <div className="text-base font-bold tracking-[0.14em] text-(--editorial-muted) uppercase">
                  Further reading
                </div>
              </PerspectiveFocus>
              <PerspectiveFocus audience="authors" minimumTime="medium">
                <p className="text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                  This website contains the full documentation for Fragno, including the user and
                  author guides, reference, and API documentation.
                </p>
              </PerspectiveFocus>
              <PerspectiveFocus audience="both" minimumTime="low">
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <Link
                    to="/docs/fragno/for-library-authors/getting-started"
                    className="text-primary-foreground inline-flex items-center justify-center bg-(--editorial-primary) px-4 py-2.5 text-sm font-medium tracking-[0.08em] transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-primary)_88%,black)]"
                  >
                    Author docs
                  </Link>
                  <Link
                    to="/docs/fragno/user-quick-start"
                    className="inline-flex items-center justify-center px-4 py-2.5 text-sm font-medium tracking-[0.08em] text-(--editorial-secondary) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--editorial-secondary)_28%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-secondary)_10%,transparent)]"
                  >
                    User quick start
                  </Link>
                  <Link
                    to="/fragments/resend/essay"
                    className="inline-flex items-center justify-center px-4 py-2.5 text-sm font-medium tracking-[0.08em] text-(--editorial-tertiary) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--editorial-tertiary)_28%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-tertiary)_10%,transparent)]"
                  >
                    Resend essay
                  </Link>
                </div>
                <div className="mt-3 tracking-[0.08em] text-[color-mix(in_srgb,var(--editorial-ink)_58%,white)]">
                  Or see Fragno in practice:{" "}
                  <Link
                    to="/fragments/resend/essay"
                    className="text-(--editorial-primary) underline underline-offset-2"
                  >
                    the Resend full-stack library essay
                  </Link>
                  .
                </div>
              </PerspectiveFocus>
            </div>

            <div className="space-y-6 border-t border-(--editorial-ghost-border) pt-10">
              <PerspectiveFocus audience="both" minimumTime="medium">
                <div className="space-y-4">
                  <div className="text-base font-bold tracking-[0.14em] uppercase">Connect</div>

                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <a
                      href="https://github.com/rejot-dev/fragno"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center px-4 py-2.5 text-sm font-medium tracking-[0.08em] text-(--editorial-primary) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--editorial-primary)_28%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-primary)_10%,transparent)]"
                    >
                      GitHub
                    </a>
                    <a
                      href="https://discord.gg/jdXZxyGCnC"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center px-4 py-2.5 text-sm font-medium tracking-[0.08em] text-(--editorial-secondary) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--editorial-secondary)_28%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-secondary)_10%,transparent)]"
                    >
                      Discord
                    </a>
                    <a
                      href="https://x.com/wilcokr"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center px-4 py-2.5 text-sm font-medium tracking-[0.08em] text-(--editorial-tertiary) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--editorial-tertiary)_28%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-tertiary)_10%,transparent)]"
                    >
                      @wilcokr on X
                    </a>
                  </div>
                </div>
              </PerspectiveFocus>

              <Form method="post" className="space-y-4">
                <p className="text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
                  Occasional email for new essays and releases. Source and chat live below.
                </p>
                <input type="hidden" name="intent" value="newsletter" />
                <label className="sr-only" htmlFor="email">
                  Email address
                </label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                  <input
                    id="email"
                    type="email"
                    name="email"
                    placeholder="you@company.com"
                    required
                    disabled={isSubmitting}
                    autoComplete="email"
                    className="min-h-11 flex-1 bg-[color-mix(in_srgb,var(--editorial-surface)_92%,transparent)] px-3 py-2.5 text-base shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] outline-none focus:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--editorial-ink)_22%,transparent),0_0_0_2px_color-mix(in_srgb,var(--editorial-ink)_6%,transparent)]"
                  />
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="text-primary-foreground inline-flex min-h-11 shrink-0 items-center justify-center bg-(--editorial-primary) px-4 py-2.5 text-sm font-medium tracking-[0.08em] transition-colors hover:bg-[color-mix(in_srgb,var(--editorial-primary)_88%,black)] disabled:opacity-60"
                  >
                    {isSubmitting ? "Subscribing…" : "Subscribe"}
                  </button>
                </div>
                {newsletterActionData?.message && (
                  <p
                    className={`text-base font-medium ${newsletterActionData.success ? "text-[#0d6b3d]" : "text-[#a12b30]"}`}
                  >
                    {newsletterActionData.message}
                  </p>
                )}
                <Turnstile
                  siteKey={turnstileSitekey}
                  options={{ appearance: "interaction-only" }}
                />
              </Form>
            </div>
          </section>
        </PerspectiveControls>
      </article>
    </main>
  );
}
