import {
  AppActionRequestError,
  createAppActionVerifier,
} from "@fragno-dev/backoffice-api/v0/app-actions";
import type { AppAction } from "@fragno-dev/backoffice-api/v0/apps";
import { backofficeScopeRootOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { BOOKS_ACTIONS, isBooksAction, runBooksAction } from "./books-actions";

/** Where Backoffice sends Bookkeeping's declared actions; registration names this URL. */
export const BACKOFFICE_ACTIONS_PATH = "/api/backoffice/actions";

/** The actions Bookkeeping registers with Backoffice; the handler below serves each one. */
export const BOOKKEEPING_BACKOFFICE_ACTIONS: AppAction[] = [
  {
    id: "organization.get",
    label: "Describe the organization",
    description:
      "Name, slug, kind (the operators who run Bookkeeping, an accounting firm, or a client whose books a firm keeps), and member count of the organization in Bookkeeping.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        slug: { type: "string" },
        kind: { type: "string", enum: ["operator", "firm", "client"] },
        memberCount: { type: "integer" },
      },
      required: ["id", "name", "slug", "kind", "memberCount"],
    },
  },
  ...BOOKS_ACTIONS,
];

let verifier: ReturnType<typeof createAppActionVerifier> | null = null;

function message(status: number, text: string) {
  return Response.json({ message: text }, { status });
}

/**
 * Serves the actions Bookkeeping declares in its Backoffice registration. Backoffice signs every
 * request for one installation; the action acts on its organization, and books actions on the
 * administration whose project the request runs in.
 */
export async function handleBackofficeAction(
  request: Request,
  env: CloudflareEnv,
): Promise<Response> {
  // The verifier caches Backoffice's signing keys, so it lives as long as the isolate.
  verifier ??= createAppActionVerifier({
    backofficeOrigin: new URL(env.BACKOFFICE_BASE_URL).origin,
    endpointUrl: new URL(BACKOFFICE_ACTIONS_PATH, env.BOOKKEEPING_BASE_URL).toString(),
    fetch,
  });
  let verified;
  try {
    verified = await verifier(request);
  } catch (error) {
    if (error instanceof AppActionRequestError) {
      return message(error.status, error.message);
    }
    throw error;
  }
  const { claims, request: call } = verified;
  const owner = backofficeScopeRootOwner(claims.scopeRestriction);
  const organization =
    owner.kind === "org"
      ? await env.DIRECTORY.getByName("directory").describeOrganization(owner.orgId)
      : null;
  if (!organization) {
    return message(403, "Bookkeeping does not know this Backoffice organization.");
  }
  if (call.type === "ping") {
    return Response.json({ ok: true });
  }
  if (call.actionId === "organization.get") {
    return Response.json(organization);
  }
  if (isBooksAction(call.actionId)) {
    return await runBooksAction(env, claims, call.actionId, call.input);
  }
  return message(404, `Bookkeeping has no action '${call.actionId}'.`);
}
