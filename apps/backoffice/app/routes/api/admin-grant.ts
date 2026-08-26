import { z } from "zod";

import type { AuthObject } from "@/backoffice-runtime/object-registry";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import type { Route } from "./+types/admin-grant";

const grantBackofficeAdminInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(191)),
});

async function adminGrantTokensMatch(providedToken: string, configuredToken: string) {
  const encoder = new TextEncoder();
  const [providedDigest, configuredDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(providedToken)),
    crypto.subtle.digest("SHA-256", encoder.encode(configuredToken)),
  ]);
  const providedBytes = new Uint8Array(providedDigest);
  const configuredBytes = new Uint8Array(configuredDigest);
  let difference = 0;
  for (let index = 0; index < providedBytes.length; index += 1) {
    difference |= providedBytes[index] ^ configuredBytes[index];
  }
  return difference === 0;
}

async function handleBackofficeAdminGrantRequest(
  request: Request,
  input: {
    configuredToken: string | undefined;
    auth: Pick<AuthObject, "grantBackofficeAdminByEmail">;
  },
): Promise<Response> {
  if (!input.configuredToken) {
    return Response.json({ error: "Admin granting is not configured." }, { status: 404 });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  const authorization = request.headers.get("authorization");
  const providedToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (!providedToken || !(await adminGrantTokensMatch(providedToken, input.configuredToken))) {
    return Response.json({ error: "Admin grant token is invalid." }, { status: 401 });
  }

  const parsedInput = grantBackofficeAdminInputSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsedInput.success) {
    return Response.json({ error: "A valid email address is required." }, { status: 400 });
  }
  if (!parsedInput.data.email.endsWith("@rejot.dev")) {
    return Response.json(
      { error: "Administrator access requires a @rejot.dev email address." },
      { status: 400 },
    );
  }

  const result = await input.auth.grantBackofficeAdminByEmail({ email: parsedInput.data.email });
  return Response.json(result);
}

function handleAdminGrantRoute({ request, context }: Route.ActionArgs | Route.LoaderArgs) {
  const { env, runtime } = context.get(BackofficeWorkerContext);
  return handleBackofficeAdminGrantRequest(request, {
    configuredToken: env.AUTH_ADMIN_GRANT_TOKEN,
    auth: runtime.objects.auth.singleton(),
  });
}

export function loader(args: Route.LoaderArgs) {
  return handleAdminGrantRoute(args);
}

export function action(args: Route.ActionArgs) {
  return handleAdminGrantRoute(args);
}
