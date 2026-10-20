import {
  AppActionRequestError,
  createAppActionVerifier,
} from "@fragno-dev/backoffice-api/v0/app-actions";
import type { AppAction } from "@fragno-dev/backoffice-api/v0/apps";
import { backofficeScopeRootOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";

/** Where Backoffice sends Bookkeeping's declared actions; registration names this URL. */
export const BACKOFFICE_ACTIONS_PATH = "/api/backoffice/actions";

/** The actions Bookkeeping registers with Backoffice; the handler below serves each one. */
export const BOOKKEEPING_BACKOFFICE_ACTIONS: AppAction[] = [
  {
    id: "organization.get",
    label: "Describe the workspace",
    description: "Name, slug, and member count of the organization's Bookkeeping workspace.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        slug: { type: "string" },
        memberCount: { type: "integer" },
      },
      required: ["id", "name", "slug", "memberCount"],
    },
  },
];

let verifier: ReturnType<typeof createAppActionVerifier> | null = null;

function message(status: number, text: string) {
  return Response.json({ message: text }, { status });
}

/**
 * Serves the actions Bookkeeping declares in its Backoffice registration. Backoffice signs every
 * request for one installation; its organization is the workspace the action acts on.
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
  const workspace =
    owner.kind === "org"
      ? await env.WORKSPACES.getByName("workspaces").describeWorkspace(owner.orgId)
      : null;
  if (!workspace) {
    return message(403, "This Backoffice organization has no Bookkeeping workspace.");
  }
  if (call.type === "ping") {
    return Response.json({ ok: true });
  }
  switch (call.actionId) {
    case "organization.get":
      return Response.json(workspace);
    default:
      return message(404, `Bookkeeping has no action '${call.actionId}'.`);
  }
}
