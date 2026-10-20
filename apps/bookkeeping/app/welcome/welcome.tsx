import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { env } from "cloudflare:workers";
import { useEffect } from "react";
import { Form, redirect, useNavigation, useRevalidator } from "react-router";
import { z } from "zod";

import type { WizardAnswer } from "../../workers/workflows/create-workspace";
import { assertSameOrigin, requireSessionUser } from "../auth/session.server";
import type { Route } from "./+types/welcome";

export function meta() {
  return [{ title: "Welcome · Bookkeeping" }];
}

const answerSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("name"),
    name: z.string().trim().min(1, "Enter your name.").max(100, "Use at most 100 characters."),
  }),
  z.object({
    intent: z.literal("business-name"),
    businessName: z
      .string()
      .trim()
      .min(1, "Enter your business's name.")
      .max(160, "Use at most 160 characters."),
  }),
]);

function workflows() {
  return env.WORKFLOWS.getByName("workflows");
}

/** The sign-up wizard for someone without a workspace; it ends in their new workspace. */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const [first] = await env.WORKSPACES.getByName("workspaces").listMemberships(
    user.backofficeUserId,
  );
  if (first) {
    throw redirect(`/w/${first.workspace.slug}`);
  }
  const wizard = await workflows().openWizard(user);
  if (wizard.step === "done") {
    throw redirect(`/w/${wizard.slug}`);
  }
  return { wizard };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(request);
  assertSameOrigin(request);
  const form = Object.fromEntries(await request.formData());
  if (form.intent === "retry") {
    await workflows().retryWizard(user.id);
    throw redirect("/welcome");
  }
  const parsed = answerSchema.safeParse(form);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check your answer." };
  }
  const answer: WizardAnswer =
    parsed.data.intent === "name"
      ? { type: "name", payload: { name: parsed.data.name } }
      : { type: "business-name", payload: { businessName: parsed.data.businessName } };
  await workflows().answerWizard({ userId: user.id, answer });
  throw redirect("/welcome");
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

function Question({
  intent,
  title,
  description,
  label,
  autoComplete,
  error,
}: {
  intent: "name" | "business-name";
  title: string;
  description: string;
  label: string;
  autoComplete: string;
  error: string | null;
}) {
  const navigation = useNavigation();
  const field = intent === "name" ? "name" : "businessName";
  return (
    <Form method="post" className="space-y-5">
      <div className="space-y-2">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <input type="hidden" name="intent" value={intent} />
      <Field label={label}>
        <Input
          className="w-full"
          name={field}
          autoComplete={autoComplete}
          required
          autoFocus
          aria-invalid={error ? true : undefined}
        />
      </Field>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant="solid"
        className="w-full"
        disabled={navigation.state !== "idle"}
      >
        Continue
      </Button>
    </Form>
  );
}

/** Checks again shortly while the workflow works. */
function Working({ title, description }: { title: string; description: string }) {
  const { revalidate, state } = useRevalidator();
  useEffect(() => {
    if (state !== "idle") {
      return undefined;
    }
    const timer = setTimeout(() => {
      void revalidate();
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [revalidate, state]);
  return (
    <div className="space-y-2" role="status">
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}

export default function Welcome({ loaderData, actionData }: Route.ComponentProps) {
  const { wizard } = loaderData;
  const error = actionData?.error ?? null;
  return (
    <section className="auth">
      {wizard.step === "name" && (
        <Question
          intent="name"
          title="Welcome! What's your name?"
          description="It's how you'll appear to the people you work with."
          label="Your name"
          autoComplete="name"
          error={error}
        />
      )}
      {wizard.step === "business-name" && (
        <Question
          intent="business-name"
          title="What's your business called?"
          description="We'll set up a workspace for its books. You can invite others to it later."
          label="Business name"
          autoComplete="organization"
          error={error}
        />
      )}
      {wizard.step === "next-question" && (
        <Working title="One moment…" description="Your next question is on its way." />
      )}
      {wizard.step === "setting-up" && (
        <Working title="Setting up your workspace…" description="This takes a few seconds." />
      )}
      {wizard.step === "failed" && (
        <Form method="post" className="space-y-4">
          <h1>We couldn't set up your workspace</h1>
          <p role="alert" className="error">
            {wizard.message}
          </p>
          <input type="hidden" name="intent" value="retry" />
          <Button type="submit" variant="solid">
            Try again
          </Button>
        </Form>
      )}
    </section>
  );
}
