import "@fragno-private/design-system/components.css";

import { Button } from "@fragno-private/design-system/button";
import { Callout } from "@fragno-private/design-system/callout";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { RadioCards } from "@fragno-private/design-system/radio-cards";
import { StandalonePageAccount } from "@fragno-private/design-system/standalone-page";
import { WorkingIndicator } from "@fragno-private/design-system/working-indicator";
import { useEffect, useState, type ReactNode } from "react";
import {
  data,
  Form,
  redirect,
  type RouterContextProvider,
  useNavigation,
  useRevalidator,
} from "react-router";

import { getBackofficeMe } from "@/fragno/auth/auth-server";
import { reopenWithBackofficeCredential } from "@/fragno/auth/browser-credential.server";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { useBackofficeSignOut } from "@/fragno/auth/use-backoffice-sign-out";
import {
  ONBOARDING_QUESTIONS,
  type OnboardingAnswer,
  type OnboardingAnswerTo,
  type OnboardingPrompt,
  type OnboardingQuestion,
  type UserOnboardingState,
} from "@/fragno/onboarding/contracts";
import { BackofficeStandaloneLayout } from "@/layouts/backoffice-standalone-layout";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/onboarding";
import { dashboardPath } from "./dashboard/path";
import { onboardingReturnTo } from "./onboarding-path";

// A form cannot submit null, so "no preference" has a value of its own.
const NO_JURISDICTION = "anywhere";

/** The onboarding page opens outside the Backoffice shell, which would open the person's scope. */
async function requireOnboardingPerson(args: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  url: URL;
}): Promise<BackofficeMeData> {
  const authentication = await getBackofficeMe(args.request, args.context);
  if (authentication.status !== "authenticated") {
    throw await reopenWithBackofficeCredential(args, { selection: "preferred" });
  }
  return authentication.me;
}

/**
 * Someone onboarded continues where they were asked to return, or starts in an organization they
 * belong to, or in their own workspace.
 */
function onboardedLandingPath(me: BackofficeMeData, url: URL): string {
  const returnTo = onboardingReturnTo(url);
  if (returnTo) {
    return returnTo;
  }
  const [first] = me.organizations;
  return first ? dashboardPath({ kind: "org", orgSlug: first.organization.slug }) : "/backoffice";
}

function systemAutomations(context: Readonly<RouterContextProvider>) {
  return context.get(BackofficeWorkerContext).runtime.objects.automations.singleton().commands;
}

export async function loader(args: Route.LoaderArgs) {
  const me = await requireOnboardingPerson(args);
  if (me.user.onboardedAt !== null) {
    throw redirect(onboardedLandingPath(me, args.url));
  }
  const state = await systemAutomations(args.context).startUserOnboarding({ userId: me.user.id });
  return {
    state,
    email: me.user.email,
    memberOf: me.organizations.map(({ organization }) => organization.name),
  };
}

/** The answer a question's form sent, or null with what to correct when it does not parse. */
function readOnboardingAnswer(
  form: FormData,
): { answer: OnboardingAnswer } | { answer: null; error: string } {
  const invalidName = { answer: null, error: "Enter a name of at most 100 characters." };
  // A form without the field, or with a file in it, answers no question.
  const question = form.get("question");
  switch (typeof question === "string" ? question : "") {
    case "usage": {
      const parsed = ONBOARDING_QUESTIONS.usage.schema.safeParse({ usage: form.get("usage") });
      return parsed.success
        ? { answer: { question: "usage", answer: parsed.data } }
        : { answer: null, error: "Choose how you will use Backoffice." };
    }
    case "organization-name": {
      const parsed = ONBOARDING_QUESTIONS["organization-name"].schema.safeParse({
        name: form.get("name"),
      });
      return parsed.success
        ? { answer: { question: "organization-name", answer: parsed.data } }
        : invalidName;
    }
    case "agency-name": {
      const parsed = ONBOARDING_QUESTIONS["agency-name"].schema.safeParse({
        name: form.get("name"),
      });
      return parsed.success
        ? { answer: { question: "agency-name", answer: parsed.data } }
        : invalidName;
    }
    case "client-name": {
      const parsed = ONBOARDING_QUESTIONS["client-name"].schema.safeParse({
        name: form.get("name"),
      });
      return parsed.success
        ? { answer: { question: "client-name", answer: parsed.data } }
        : invalidName;
    }
    case "more-clients": {
      const more = form.get("more");
      const parsed = ONBOARDING_QUESTIONS["more-clients"].schema.safeParse({
        more: more === "true" ? true : more === "false" ? false : more,
      });
      return parsed.success
        ? { answer: { question: "more-clients", answer: parsed.data } }
        : { answer: null, error: "Add another client or finish setting up." };
    }
    case "jurisdiction": {
      const jurisdiction = form.get("jurisdiction");
      const parsed = ONBOARDING_QUESTIONS.jurisdiction.schema.safeParse({
        jurisdiction: jurisdiction === NO_JURISDICTION ? null : jurisdiction,
      });
      return parsed.success
        ? { answer: { question: "jurisdiction", answer: parsed.data } }
        : { answer: null, error: "Choose where your data is kept." };
    }
    default:
      return { answer: null, error: "Answer the question on this page." };
  }
}

export async function action(args: Route.ActionArgs) {
  const me = await requireOnboardingPerson(args);
  if (me.user.onboardedAt !== null) {
    throw redirect(onboardedLandingPath(me, args.url));
  }
  const read = readOnboardingAnswer(await args.request.formData());
  if (!read.answer) {
    return data({ error: read.error }, { status: 400 });
  }
  await systemAutomations(args.context).answerUserOnboarding({
    userId: me.user.id,
    answer: read.answer,
  });
  // Onboarding continues on this page, which keeps where it returns to.
  throw redirect(`${args.url.pathname}${args.url.search}`);
}

export function meta() {
  return [{ title: "Set up Backoffice" }];
}

export default function BackofficeOnboarding({ loaderData, actionData }: Route.ComponentProps) {
  const { state, email, memberOf } = loaderData;
  return (
    <BackofficeStandaloneLayout headerEnd={<OnboardingAccount email={email} />}>
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-5 py-10">
        <OnboardingStep state={state} memberOf={memberOf} error={actionData?.error ?? null} />
      </div>
    </BackofficeStandaloneLayout>
  );
}

/** Who is onboarding, who may have signed up with an address they meant not to use. */
function OnboardingAccount({ email }: { email: string }) {
  const { signOut, signingOut } = useBackofficeSignOut();
  return (
    <StandalonePageAccount
      email={email}
      signOut={
        <Button variant="ghost" type="button" disabled={signingOut} onClick={signOut}>
          {signingOut ? "Signing out…" : "Sign out"}
        </Button>
      }
    />
  );
}

function OnboardingStep({
  state,
  memberOf,
  error,
}: {
  state: UserOnboardingState;
  memberOf: readonly string[];
  error: string | null;
}) {
  switch (state.status) {
    case "asking":
      // A new question, or another round of one, is a new form, not the last one's typed input.
      return (
        <Question
          key={promptKey(state.prompt)}
          prompt={state.prompt}
          memberOf={memberOf}
          error={error}
        />
      );
    case "setting-up":
    case "complete":
      return <SettingUp />;
    case "failed":
      return (
        <Callout tone="failed" title="Setup stopped">
          {state.message} Contact support to finish setting up your account.
        </Callout>
      );
    default:
      throw new Error("Unsupported onboarding state.", { cause: state satisfies never });
  }
}

function QuestionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-2">
      <h1 className="text-3xl leading-tight font-semibold text-balance">{title}</h1>
      <p className="text-sm text-pretty text-[var(--bo-muted)]">{description}</p>
    </div>
  );
}

/** Names the question onboarding asks, and which round of it. */
function promptKey(prompt: OnboardingPrompt): string {
  switch (prompt.question) {
    case "client-name":
      return `${prompt.question}:${prompt.client}`;
    case "more-clients":
      return `${prompt.question}:${prompt.clients.length}`;
    case "usage":
    case "jurisdiction":
    case "organization-name":
    case "agency-name":
      return prompt.question;
    default:
      throw new Error("Unsupported onboarding question.", { cause: prompt satisfies never });
  }
}

/** The page asking one question, the only one on it. */
function Question({
  prompt,
  memberOf,
  error,
}: {
  prompt: OnboardingPrompt;
  memberOf: readonly string[];
  error: string | null;
}) {
  switch (prompt.question) {
    case "usage":
      return <UsageQuestion error={error} />;
    case "jurisdiction":
      return <JurisdictionQuestion memberOf={memberOf} error={error} />;
    case "organization-name":
      return (
        <NameQuestion
          question={prompt.question}
          title="What is your organization called?"
          description="Your team shares its projects, automations, and integrations. You can rename it later."
          label="Organization name"
          submitLabel="Create organization"
          error={error}
        />
      );
    case "agency-name":
      return (
        <NameQuestion
          question={prompt.question}
          title="What is your agency called?"
          description="Your agency manages an organization for each of its clients. You can rename it later."
          label="Agency name"
          submitLabel="Create agency"
          error={error}
        />
      );
    case "client-name":
      return (
        <NameQuestion
          question={prompt.question}
          title={prompt.client === 1 ? "Who is your first client?" : "Who is your next client?"}
          description="Each client gets an organization your agency manages. You can add more later."
          label="Client name"
          submitLabel="Create client"
          error={error}
        />
      );
    case "more-clients":
      return <MoreClientsQuestion clients={prompt.clients} error={error} />;
    default:
      throw new Error("Unsupported onboarding question.", { cause: prompt satisfies never });
  }
}

/** A question's form, which names the question it answers, and the buttons that answer it. */
function QuestionForm({
  question,
  title,
  description,
  error,
  actions,
  children,
}: {
  question: OnboardingQuestion;
  title: string;
  description: string;
  error: string | null;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <Form method="post" className="space-y-6">
      <input type="hidden" name="question" value={question} />
      <QuestionHeading title={title} description={description} />
      {children}
      {error ? (
        <Callout tone="failed" title="Check your answer">
          {error}
        </Callout>
      ) : null}
      <div className="flex flex-wrap gap-2">{actions}</div>
    </Form>
  );
}

/**
 * Submits the question's form, saying it saves while this button's answer is on its way. A button
 * with a value is one of several answers; only the one pressed says so.
 */
function SubmitButton({
  label,
  variant,
  value,
}: {
  label: string;
  variant: "accent" | "secondary";
  value: { name: string; value: string } | null;
}) {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle" && navigation.formMethod === "POST";
  const pressed = value === null || navigation.formData?.get(value.name) === value.value;
  return (
    <Button
      variant={variant}
      type="submit"
      disabled={submitting}
      {...(value === null ? {} : { name: value.name, value: value.value })}
    >
      {submitting && pressed ? "Saving…" : label}
    </Button>
  );
}

/** Asks for the name of one organization, which onboarding creates next. */
function NameQuestion({
  question,
  title,
  description,
  label,
  submitLabel,
  error,
}: {
  question: "organization-name" | "agency-name" | "client-name";
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  error: string | null;
}) {
  return (
    <QuestionForm
      question={question}
      title={title}
      description={description}
      error={error}
      actions={<SubmitButton label={submitLabel} variant="accent" value={null} />}
    >
      <Field label={label} required>
        <Input type="text" name="name" required maxLength={100} className="w-full" />
      </Field>
    </QuestionForm>
  );
}

/** After each client onboarding created, offers another or finishing. */
function MoreClientsQuestion({
  clients,
  error,
}: {
  clients: readonly string[];
  error: string | null;
}) {
  return (
    <QuestionForm
      question="more-clients"
      title="Add another client?"
      description={`Your agency manages ${listNames(clients)}. You can also add clients later.`}
      error={error}
      actions={
        <>
          <SubmitButton
            label="Add another client"
            variant="secondary"
            value={{ name: "more", value: "true" }}
          />
          <SubmitButton
            label="Finish setup"
            variant="accent"
            value={{ name: "more", value: "false" }}
          />
        </>
      }
    >
      {null}
    </QuestionForm>
  );
}

/** "Acme", "Acme and Globex", or "Acme, Globex, and Initech". */
function listNames(names: readonly string[]): string {
  return new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names);
}

type Usage = OnboardingAnswerTo<"usage">["usage"];

function UsageQuestion({ error }: { error: string | null }) {
  const [usage, setUsage] = useState<Usage>("personal");
  return (
    <QuestionForm
      question="usage"
      title="How will you use Backoffice?"
      description="This decides what Backoffice sets up for you. You can create more organizations later."
      error={error}
      actions={<SubmitButton label="Continue" variant="accent" value={null} />}
    >
      <RadioCards
        label="How you use Backoffice"
        name="usage"
        value={usage}
        onValueChange={setUsage}
        options={[
          {
            value: "personal",
            label: "Just me",
            description: "Work in your own workspace. Nothing else to set up.",
          },
          {
            value: "organization",
            label: "My organization",
            description: "Share projects, automations, and integrations with your team.",
          },
          {
            value: "agency",
            label: "An agency",
            description: "Run Backoffice for clients, each in an organization your agency manages.",
          },
        ]}
      />
    </QuestionForm>
  );
}

type JurisdictionChoice = typeof NO_JURISDICTION | "eu" | "us";

function JurisdictionQuestion({
  memberOf,
  error,
}: {
  memberOf: readonly string[];
  error: string | null;
}) {
  const [jurisdiction, setJurisdiction] = useState<JurisdictionChoice>(NO_JURISDICTION);
  return (
    <QuestionForm
      question="jurisdiction"
      title="Where should your data be kept?"
      description={
        memberOf.length > 0
          ? `You are a member of ${memberOf.join(", ")}. This choice is for your own workspace; it cannot be changed later.`
          : "Your workspace and the organizations you set up keep their data here. It cannot be changed later."
      }
      error={error}
      actions={<SubmitButton label="Continue" variant="accent" value={null} />}
    >
      <RadioCards
        label="Where your data is kept"
        name="jurisdiction"
        value={jurisdiction}
        onValueChange={setJurisdiction}
        options={[
          {
            value: NO_JURISDICTION,
            label: "No preference",
            description: "Data is kept close to wherever it is used.",
          },
          {
            value: "eu",
            label: "European Union",
            description: "Data stays in the EU, such as for the GDPR.",
          },
          { value: "us", label: "United States", description: "Data stays in the United States." },
        ]}
      />
    </QuestionForm>
  );
}

/** The workflow works on the answer asynchronously, so the page checks back until it moves on. */
function SettingUp() {
  const revalidator = useRevalidator();
  useEffect(() => {
    const interval = setInterval(() => {
      if (revalidator.state === "idle") {
        void revalidator.revalidate();
      }
    }, 1_000);
    return () => {
      clearInterval(interval);
    };
  }, [revalidator]);

  return (
    <div className="space-y-4">
      <QuestionHeading
        title="Setting up Backoffice"
        description="This takes a moment. The page continues on its own."
      />
      <WorkingIndicator>Working on your answers…</WorkingIndicator>
    </div>
  );
}
