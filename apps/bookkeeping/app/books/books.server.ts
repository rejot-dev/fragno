import type { DimensionRules } from "@fragno-dev/ledger/schema";
import { env } from "cloudflare:workers";
import type { z } from "zod";

import type { Outcome } from "../../workers/books/books";
import { canManage } from "../../workers/directory/membership";
import { assertSameOrigin } from "../auth/session.server";
import { requireOrganization } from "../organizations/access.server";

type BooksParams = { slug: string; administration: string };

/** What a form on a books page answers: which form it was, and why it was refused. */
export type FormResult = { intent: string; error: string | null };

/**
 * The signed-in person in an administration's books. Everyone in the client's workspace keeps
 * them; setting them up (the calendar, journals, dimensions, currencies, and chart of accounts)
 * is for its owners and admins.
 */
export async function requireBooks(request: Request, params: BooksParams) {
  const context = await requireOrganization(request, params.slug, "client");
  const administration = await env.DIRECTORY.getByName("directory").findAdministration({
    clientId: context.organization.id,
    slug: params.administration,
  });
  if (!administration) {
    throw new Response("This administration does not exist.", { status: 404 });
  }
  return {
    ...context,
    administration,
    canSetUp: canManage(context.roles),
    books: env.BOOKS.getByName(administration.id),
  };
}

/** `requireBooks` for a form submission, which may need to set the books up. */
export async function requireBooksSubmission(
  request: Request,
  params: BooksParams,
  access: "keep" | "set-up",
) {
  const context = await requireBooks(request, params);
  assertSameOrigin(request);
  if (access === "set-up" && !context.canSetUp) {
    throw new Response("Only owners and admins set up the books.", { status: 403 });
  }
  return context;
}

/**
 * The submitted form parsed by `schema`, with every field as submitted for fields named after
 * the books' own records; or the form result naming its first problem.
 *
 * `resultIntent` is the intent the form's result answers to. A form shown once per record submits
 * its own, e.g. `reverse-<entryId>`, so its result shows under that record's form, refusals of
 * the schema included; other forms answer to their intent.
 */
export async function parseForm<TSchema extends z.ZodType<{ intent: string }>>(
  request: Request,
  schema: TSchema,
): Promise<
  | { data: z.infer<TSchema>; form: Record<string, unknown>; resultIntent: string }
  | { refusal: FormResult }
> {
  const form: Record<string, unknown> = Object.fromEntries(await request.formData());
  const submitted = typeof form.resultIntent === "string" ? form.resultIntent : form.intent;
  const resultIntent = typeof submitted === "string" ? submitted : "";
  const parsed = schema.safeParse(form);
  if (parsed.success) {
    return { data: parsed.data, form, resultIntent };
  }
  return {
    refusal: { intent: resultIntent, error: parsed.error.issues[0]?.message ?? "Check the form." },
  };
}

/** The form result of a ledger operation: the ledger's refusal is the form's error. */
export function formResult(intent: string, outcome: Outcome<unknown>): FormResult {
  return { intent, error: outcome.ok ? null : outcome.message };
}

/**
 * The dimension rules submitted as `dimension.<id>` fields, one per dimension: required, not
 * allowed, or optional, which is no rule.
 */
export function dimensionRules(
  form: Record<string, unknown>,
  dimensions: readonly { id: string }[],
): DimensionRules {
  const rules: DimensionRules = {};
  for (const dimension of dimensions) {
    const rule = form[`dimension.${dimension.id}`];
    if (rule === "required" || rule === "forbidden") {
      rules[dimension.id] = rule;
    }
  }
  return rules;
}
