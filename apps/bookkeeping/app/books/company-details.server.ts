import { BackofficeApiRequestError } from "@fragno-dev/backoffice-api/v0/client";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { COMPANY_DETAILS_AGENT_NAME } from "../../workers/backoffice/agents";
import { backofficeOrigin } from "../../workers/backoffice/client";
import { parseIban } from "../../workers/books/banking/iban";
import type { PartyDetails } from "../../workers/books/party-details/party-details";
import { backofficeProblem } from "../organizations/access.server";
import { connectToAdministrationAsUser, type requireBooks } from "./books.server";

type BooksContext = Awaited<ReturnType<typeof requireBooks>>;

/** The party a lookup is about, as the books name it. */
type LookedUpParty = { id: string; name: string; role: "customer" | "supplier" };

/**
 * Where a lookup of a party's company details stands: the agent `looking`; what it `found`, for
 * the person to review before saving; what it did not find; or that the person's personal
 * workspace `refused` it, with where they let Bookkeeping in, when the refusal names it.
 */
export type CompanyDetailsLookup =
  | { status: "looking" }
  | {
      status: "found";
      source: string;
      details: PartyDetails;
      /** What the source gave as the IBAN when it is not one, for the person to see and correct. */
      invalidIban: string | null;
    }
  | { status: "not-found"; reason: string }
  | { status: "refused"; message: string; allowUrl: string | null }
  | { status: "failed"; reason: string };

const AGENT_INSTALLING = "Looking up company details is being set up. Try again in a moment.";

/** Each lookup's request ID names its party, so a page reads only its own party's lookups. */
function requestPrefix(partyId: string): string {
  return `company-details:${partyId}:`;
}

/**
 * Asks the administration's company-details agent, as the signed-in person, to look up the party's
 * details in their own connections; returns the lookup's request ID, or why it was not asked with
 * the request ID to retry it with. A failed submission may still have started the lookup, as when
 * Backoffice's answer was lost, and Backoffice queues a request ID once: retrying with it never
 * starts a second lookup.
 */
export async function startCompanyDetailsLookup(
  request: Request,
  context: BooksContext,
  party: LookedUpParty,
  retrying: string | null,
): Promise<{ ok: true; requestId: string } | { ok: false; error: string; requestId: string }> {
  const requestId = retrying ?? `${requestPrefix(party.id)}${crypto.randomUUID()}`;
  if (!requestId.startsWith(requestPrefix(party.id))) {
    return {
      ok: false,
      error: "This lookup is not about this customer or supplier.",
      requestId: `${requestPrefix(party.id)}${crypto.randomUUID()}`,
    };
  }
  const { backoffice, scope } = await connectToAdministrationAsUser(request, context);
  // Says whether the project had the agent to ask.
  const submit = async () => {
    try {
      await backoffice.call(scope, "pi.prompt.submit", {
        agentName: COMPANY_DETAILS_AGENT_NAME,
        requestId,
        // A conversation of its own, so lookups never see each other's results.
        subagent: true,
        content: `Look up the company details of the ${party.role} "${party.name}" for ${context.user.name}, whose user ID is \`${context.user.backofficeUserId}\`.`,
      });
      return true;
    } catch (error) {
      if (error instanceof BackofficeApiRequestError && error.code === "not_found") {
        return false;
      }
      throw error;
    }
  };
  try {
    if (await submit()) {
      return { ok: true, requestId };
    }
    // The project has no agent, as when its package predates the agent or was removed while
    // Bookkeeping was uninstalled: the package is installed again, as the chat does.
    await env.DIRECTORY.getByName("directory").reinstallAgentPackage(context.administration.id);
    return (await submit())
      ? { ok: true, requestId }
      : { ok: false, error: AGENT_INSTALLING, requestId };
  } catch (error) {
    return { ok: false, error: backofficeProblem(error), requestId };
  }
}

/** Where the lookup `requestId` of the party stands, read as the person who started it. */
export async function readCompanyDetailsLookup(
  request: Request,
  context: BooksContext,
  input: { partyId: string; requestId: string },
): Promise<CompanyDetailsLookup> {
  if (!input.requestId.startsWith(requestPrefix(input.partyId))) {
    return { status: "failed", reason: "This lookup is not about this customer or supplier." };
  }
  const { backoffice, scope } = await connectToAdministrationAsUser(request, context);
  let progress;
  try {
    progress = await backoffice.call(scope, "pi.prompt.get", {
      agentName: COMPANY_DETAILS_AGENT_NAME,
      requestId: input.requestId,
    });
  } catch (error) {
    return { status: "failed", reason: backofficeProblem(error) };
  }
  if (progress === null) {
    return { status: "failed", reason: "This lookup was never started. Look up again." };
  }
  switch (progress.status) {
    case "queued":
    case "running":
      return { status: "looking" };
    case "failed":
      return { status: "failed", reason: progress.reason };
    case "completed":
      return readAnswer(progress.answer, context.organization.id);
    default:
      throw new Error("Unsupported prompt status.", { cause: progress satisfies never });
  }
}

const answerSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("found"),
    source: z.string().trim().min(1),
    details: z.object({
      registrationNumber: z.string().nullable(),
      vatNumber: z.string().nullable(),
      iban: z.string().nullable(),
      address: z.string().nullable(),
    }),
  }),
  z.object({ status: z.literal("refused"), message: z.string().trim().min(1) }),
  z.object({ status: z.literal("not-found"), reason: z.string().trim().min(1) }),
]);

/** A detail as the books keep it: trimmed, and null when empty. */
function detail(value: string | null): string | null {
  const trimmed = value?.replace(/\s+/gu, " ").trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * The agent's answer, which is a model's text: read as its instructions ask, a JSON object,
 * possibly in a code fence; anything else is a failed lookup. An IBAN that is not one is reported
 * as such, never mistaken for no IBAN.
 */
function readAnswer(answer: string | null, organizationId: string): CompanyDetailsLookup {
  const unreadable = {
    status: "failed",
    reason: "The lookup answered something unreadable.",
  } as const;
  const text = answer
    ?.trim()
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "");
  if (!text) {
    return unreadable;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return unreadable;
  }
  const parsed = answerSchema.safeParse(json);
  if (!parsed.success) {
    return unreadable;
  }
  const answered = parsed.data;
  switch (answered.status) {
    case "found": {
      const iban = detail(answered.details.iban);
      const parsedIban = iban === null ? null : parseIban(iban);
      return {
        status: "found",
        source: answered.source,
        details: {
          registrationNumber: detail(answered.details.registrationNumber),
          vatNumber: detail(answered.details.vatNumber),
          iban: parsedIban,
          address: detail(answered.details.address),
        },
        invalidIban: iban !== null && parsedIban === null ? iban : null,
      };
    }
    case "refused":
      return {
        status: "refused",
        message: answered.message,
        allowUrl: allowPageUrl(answered.message, organizationId),
      };
    case "not-found":
      return answered;
    default:
      throw new Error("Unsupported lookup answer.", { cause: answered satisfies never });
  }
}

/**
 * Where the person lets Bookkeeping into their personal workspace for this client, when the refusal
 * names that page; null otherwise. The link is built from Bookkeeping's own app ID and this client,
 * never taken from the answer, which is a model's text.
 */
function allowPageUrl(message: string, organizationId: string): string | null {
  const path = `/backoffice/apps/${encodeURIComponent(env.BACKOFFICE_APP_ID)}/member-reach/${encodeURIComponent(organizationId)}`;
  return message.includes(path) ? `${backofficeOrigin(env)}${path}` : null;
}
