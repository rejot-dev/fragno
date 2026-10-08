import { z } from "zod";

import { appInstallationExternalAccountSchema } from "@/fragno/app-installations/contracts";
import { verifyAppInstallationCode } from "@/fragno/auth/token-lifecycle";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/backoffice-app-installation-claim";

const claimRequestSchema = z.strictObject({
  code: z.string().min(1),
  externalAccount: appInstallationExternalAccountSchema,
});

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Lets an app's server link one of its own accounts to an installation an organization admin
 * just approved. The install code proves that approval and travels through the browser; the
 * client-credentials token proves the caller is the app it was issued for. Neither alone suffices.
 */
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  const bearer = /^Bearer\s+([^\s]+)$/iu.exec(request.headers.get("authorization")?.trim() ?? "");
  if (!bearer) {
    return jsonResponse(
      { error: "authentication_failed", message: "A client-credentials bearer token is required." },
      401,
    );
  }
  const input = claimRequestSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) {
    return jsonResponse(
      {
        error: "invalid_request",
        message: "The body must contain a code and an externalAccount with an id and label.",
      },
      400,
    );
  }

  const { runtime } = context.get(BackofficeWorkerContext);
  const auth = runtime.objects.auth.singleton();
  let app: { appId: string };
  try {
    app = await auth.commands.authenticateInstalledAppClient({
      requestUrl: request.url,
      oauthAccessToken: bearer[1],
    });
  } catch (error) {
    if (error instanceof Error && error.name === "BackofficeExecutionTokenAuthenticationError") {
      return jsonResponse({ error: "authentication_failed", message: error.message }, 401);
    }
    throw error;
  }

  const code = await verifyAppInstallationCode(input.data.code, request.url, auth.http);
  if (!code.ok || code.payload.appId !== app.appId) {
    return jsonResponse(
      {
        error: "invalid_code",
        message:
          code.ok || code.reason !== "expired"
            ? "The installation code is invalid for this app."
            : "The installation code has expired; install the app again.",
      },
      400,
    );
  }

  const claimed = await runtime.objects.appInstallations
    .forOrg(code.payload.organizationId)
    .commands.claimInstallation({
      appId: app.appId,
      activation: code.payload.activation,
      externalAccount: input.data.externalAccount,
    });
  return claimed.ok
    ? jsonResponse(claimed.value, 200)
    : jsonResponse(
        { error: claimed.error.code.toLowerCase(), message: claimed.error.message },
        409,
      );
}
