import "../../backoffice.css";

import { data, Form, redirect, useActionData, useLoaderData } from "react-router";
import { z } from "zod";

import { FormContainer } from "@/components/backoffice";
import { callBetterAuth } from "@/fragno/auth/auth-server";
import { getAuthDurableObject } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/device";
import { buildBackofficeLoginPath } from "./auth-navigation";

const deviceUserCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
const betterAuthSessionSchema = z.object({
  user: z.object({ id: z.string().min(1), email: z.email() }),
});
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

  const sessionResponse = await callBetterAuth(request, context, "/get-session");
  const session = sessionResponse.ok
    ? betterAuthSessionSchema.safeParse(await sessionResponse.json())
    : null;
  if (!session?.success) {
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

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

export function meta() {
  return [
    { title: "Authorize Fragno Backoffice Codemode" },
    { name: "description", content: "Approve a local Backoffice codemode login." },
  ];
}

export default function BackofficeDeviceAuthorization() {
  const authorization = useLoaderData<BackofficeDeviceLoaderData>();
  const actionData = useActionData<BackofficeDeviceActionData>();

  return (
    <div
      data-backoffice-root
      className="relative isolate min-h-screen bg-[var(--bo-bg)] text-[var(--bo-fg)]"
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,rgba(var(--bo-overlay),0.96),rgba(var(--bo-overlay),0.96)),linear-gradient(90deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px),linear-gradient(0deg,rgba(var(--bo-grid),0.45)_1px,transparent_1px)] bg-[size:100%_100%,28px_28px,28px_28px]" />
      <div className="relative mx-auto flex min-h-screen max-w-5xl items-center justify-center px-4 py-8">
        <div className="w-full max-w-md">
          <FormContainer
            title="Authorize device"
            description={`${authorization.clientName} is requesting access to your account.`}
            eyebrow="Codemode"
          >
            {actionData?.status === "approved" ? (
              <p className="text-sm text-[var(--bo-muted)]">
                Device approved. Return to the terminal to finish signing in.
              </p>
            ) : actionData?.status === "denied" ? (
              <p className="text-sm text-[var(--bo-muted)]">
                Device denied. You can close this page.
              </p>
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
                  <p className="mt-1 text-sm text-[var(--bo-muted)]">
                    {authorization.scopes.join(", ")}
                  </p>
                </div>
                <p className="border border-[color:var(--bo-waiting)] bg-[var(--bo-waiting-bg)] p-3 text-sm leading-6 font-medium text-pretty text-[var(--bo-fg)]">
                  Approving grants this device full Backoffice access as your user. Only continue if
                  you started this login from your local codemode CLI.
                </p>
                {actionData?.status === "error" ? (
                  <p className="text-sm text-[var(--bo-failed)]">{actionData.message}</p>
                ) : null}
                <Form method="post" className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="submit"
                    name="intent"
                    value="approve"
                    className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)]"
                  >
                    Approve
                  </button>
                  <button
                    type="submit"
                    name="intent"
                    value="deny"
                    className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-4 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                  >
                    Deny
                  </button>
                </Form>
              </div>
            )}
          </FormContainer>
        </div>
      </div>
    </div>
  );
}
