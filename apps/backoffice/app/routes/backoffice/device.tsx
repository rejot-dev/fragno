import "@fragno-private/design-system/components.css";

import { AuthorizationScreen } from "@fragno-private/design-system/authorization-screen";
import { Button } from "@fragno-private/design-system/button";
import { data, Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { z } from "zod";

import { callBetterAuth } from "@/fragno/auth/auth-server";
import { requireBackofficeBrowserSession } from "@/fragno/auth/browser-session.server";
import { getAuthDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/device";

const deviceUserCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
const deviceAuthorizationSchema = z.object({
  user_code: z.string().min(1),
  status: z.string().min(1),
  client_id: z.string().min(1),
  scope: z.string().default(""),
});
const deviceActionInputSchema = z.object({
  intent: z.enum(["approve", "deny"]),
});

type BackofficeDeviceLoaderData = {
  clientName: string;
  userCode: string;
  scopes: string[];
};

type BackofficeDeviceActionData =
  | { status: "approved" | "denied" }
  | { status: "error"; message: string };

async function loadBackofficeDeviceAuthorization(
  request: Request,
  context: Route.LoaderArgs["context"],
  url: URL,
): Promise<BackofficeDeviceLoaderData> {
  const userCode = deviceUserCodeSchema.safeParse(url.searchParams.get("user_code"));
  if (!userCode.success) {
    throw new Response("A valid device user code is required.", { status: 400 });
  }

  await requireBackofficeBrowserSession(request, context);

  const config = await getAuthDurableObject(context).commands.getBackofficeCliOAuthConfig({
    requestUrl: request.url,
  });
  const deviceResponse = await callBetterAuth(
    request,
    context,
    `/device?user_code=${encodeURIComponent(userCode.data)}`,
  );
  if (!deviceResponse.ok) {
    throw new Response("This device authorization request is invalid or expired.", {
      status: 400,
    });
  }

  const deviceAuthorization = deviceAuthorizationSchema.safeParse(await deviceResponse.json());
  if (!deviceAuthorization.success || deviceAuthorization.data.client_id !== config.clientId) {
    throw new Response("This device authorization request is not available to Backoffice.", {
      status: 400,
    });
  }

  return {
    clientName: "Fragno Backoffice Codemode",
    userCode: userCode.data,
    scopes: deviceAuthorization.data.scope.split(/\s+/).filter(Boolean),
  };
}

export async function loader({ request, context, url }: Route.LoaderArgs) {
  return await loadBackofficeDeviceAuthorization(request, context, url);
}

export async function action({ request, context, url }: Route.ActionArgs) {
  const formData = await request.formData();
  const input = deviceActionInputSchema.safeParse(Object.fromEntries(formData));
  if (!input.success) {
    return data(
      {
        status: "error",
        message: "Choose whether to approve or deny this request.",
      } satisfies BackofficeDeviceActionData,
      { status: 400 },
    );
  }

  const authorization = await loadBackofficeDeviceAuthorization(request, context, url);
  const endpoint = input.data.intent === "approve" ? "/device/approve" : "/device/deny";
  const response = await callBetterAuth(request, context, endpoint, {
    method: "POST",
    body: JSON.stringify({ userCode: authorization.userCode }),
  });
  if (!response.ok) {
    const error = (await response.json()) as {
      error_description?: string;
      message?: string;
    };
    return data(
      {
        status: "error",
        message: error?.error_description ?? error?.message ?? "Unable to update this request.",
      } satisfies BackofficeDeviceActionData,
      { status: response.status },
    );
  }

  return {
    status: input.data.intent === "approve" ? "approved" : "denied",
  } satisfies BackofficeDeviceActionData;
}

export function headers() {
  return { "cache-control": "no-store", "referrer-policy": "no-referrer" };
}

export function meta() {
  return [
    { title: "Authorize Fragno Backoffice Codemode" },
    { name: "description", content: "Approve a local Backoffice codemode login." },
  ];
}

export default function BackofficeDeviceAuthorization() {
  const authorization = useLoaderData<BackofficeDeviceLoaderData>();
  const actionData = useActionData<BackofficeDeviceActionData>();
  const navigation = useNavigation();
  const pending = navigation.state !== "idle";

  return (
    <AuthorizationScreen
      title="Authorize device"
      description={`${authorization.clientName} is requesting access to your account.`}
      eyebrow="Codemode"
    >
      {actionData?.status === "approved" ? (
        <div className="space-y-3">
          <p className="text-sm text-[var(--bo-muted)]">
            Device approved. Return to the terminal to finish signing in.
          </p>
          <Link
            to="/backoffice"
            className="inline-flex min-h-10 items-center text-sm text-[var(--bo-fg)] underline underline-offset-4 hover:text-[var(--bo-accent)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--bo-accent)]"
          >
            Go to dashboard
          </Link>
        </div>
      ) : actionData?.status === "denied" ? (
        <p className="text-sm text-[var(--bo-muted)]">Device denied. You can close this page.</p>
      ) : (
        <div className="space-y-4">
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
            <p className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Device code
            </p>
            <p className="mt-2 font-mono text-2xl tracking-[0.18em] text-[var(--bo-fg)]">
              {authorization.userCode}
            </p>
          </div>
          <div>
            <p className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Requested scope
            </p>
            <p className="mt-1 text-sm text-[var(--bo-muted)]">{authorization.scopes.join(", ")}</p>
          </div>
          <p className="border border-[color:var(--bo-waiting)] bg-[var(--bo-waiting-bg)] p-3 text-sm leading-6 font-medium text-pretty text-[var(--bo-fg)]">
            Approving grants this device full Backoffice access as your user. Only continue if you
            started this login from your local codemode CLI.
          </p>
          {actionData?.status === "error" ? (
            <p className="text-sm text-[var(--bo-failed)]">{actionData.message}</p>
          ) : null}
          <Form method="post" className="flex flex-col gap-2 sm:flex-row">
            <Button variant="accent" type="submit" name="intent" value="approve" disabled={pending}>
              Approve
            </Button>
            <Button variant="secondary" type="submit" name="intent" value="deny" disabled={pending}>
              Deny
            </Button>
          </Form>
        </div>
      )}
      <p className="mt-4 text-xs leading-5 text-[var(--bo-muted-2)]">
        Review or revoke this authorization in{" "}
        <Link
          to="/backoffice/settings/authorized-applications"
          className="underline underline-offset-4 hover:text-[var(--bo-fg)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--bo-accent)]"
        >
          Settings → Authorized applications
        </Link>
        .
      </p>
    </AuthorizationScreen>
  );
}
