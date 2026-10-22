import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { env } from "cloudflare:workers";
import { Form, redirect, useNavigation } from "react-router";
import { z } from "zod";

import type { SessionUser } from "../../workers/auth/auth";
import {
  assertSameOrigin,
  currentPath,
  getSessionUser,
  safeReturnTo,
} from "../auth/session.server";
import type { Route } from "./+types/name";

export function meta() {
  return [{ title: "Welcome · Bookkeeping" }];
}

const nameSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(100, "Use at most 100 characters."),
});

/** Asks for a name when Backoffice has none, which is the case after an email-code sign-up. */
async function requireNameless(request: Request): Promise<{ user: SessionUser; returnTo: string }> {
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
  const user = await getSessionUser(request);
  if (!user) {
    throw redirect(`/login?returnTo=${encodeURIComponent(currentPath(request))}`);
  }
  if (user.name.trim() !== "") {
    throw redirect(returnTo);
  }
  return { user, returnTo };
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await requireNameless(request);
  return { email: user.email };
}

export async function action({ request }: Route.ActionArgs) {
  const { user, returnTo } = await requireNameless(request);
  assertSameOrigin(request);
  const parsed = nameSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check your name." };
  }
  await env.AUTH.getByName("auth").setUserName({ userId: user.id, name: parsed.data.name });
  throw redirect(returnTo);
}

export default function Name({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const error = actionData?.error ?? null;
  return (
    <section className="auth">
      <Form method="post" className="space-y-5">
        <div className="space-y-2">
          <h1>Welcome! What's your name?</h1>
          <p>
            It's how you'll appear to the people you work with. You're signed in as{" "}
            {loaderData.email}.
          </p>
        </div>
        <Field label="Your name">
          <Input
            className="w-full"
            name="name"
            autoComplete="name"
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
    </section>
  );
}
