import { Link, useLoaderData } from "react-router";

import type { Route } from "./+types/api-oauth-complete";

type ApiOAuthCompleteLoaderData = {
  orgId: string | null;
  connectionSlug: string | null;
  status: "success" | "error";
  code: string | null;
  message: string | null;
};

const readableMessage = (message: string | null) =>
  message?.trim() || "Backoffice received the OAuth callback, but the API fragment rejected it.";

const explanationFor = (message: string | null) => {
  const normalized = message?.toLowerCase() ?? "";
  if (
    normalized.includes("client cannot authenticate") ||
    normalized.includes("client_secret_basic") ||
    normalized.includes("client_secret_post")
  ) {
    return "The OAuth provider rejected the token-exchange authentication method. This usually means the client is registered as a public PKCE client and should use token endpoint auth method `none`, or the provider-side app registration does not allow the selected client-secret method.";
  }
  return "The provider redirected back to Backoffice successfully, but the final token exchange failed.";
};

export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") === "success" ? "success" : "error";
  const orgId = url.searchParams.get("orgId")?.trim() || null;
  const connectionSlug = url.searchParams.get("connection")?.trim() || null;
  const code = url.searchParams.get("code")?.trim() || null;
  const message = url.searchParams.get("message")?.trim() || null;

  return { orgId, connectionSlug, status, code, message } satisfies ApiOAuthCompleteLoaderData;
}

export function meta({ data }: Route.MetaArgs) {
  return [{ title: data?.status === "success" ? "API OAuth connected" : "API OAuth failed" }];
}

export default function BackofficeApiOAuthComplete() {
  const { orgId, connectionSlug, status, code, message } = useLoaderData<typeof loader>();
  const isSuccess = status === "success";
  const backUrl = "/backoffice/connections";

  return (
    <section className="mx-auto max-w-4xl overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="relative overflow-hidden border-b border-[color:var(--bo-border)] bg-[linear-gradient(135deg,rgba(255,255,255,0.04),transparent_44%),radial-gradient(circle_at_top_right,var(--bo-accent-bg),transparent_38%)] p-6">
        <div className="absolute top-0 right-0 h-32 w-32 translate-x-10 -translate-y-10 rounded-full border border-[color:var(--bo-border)] opacity-40" />
        <div
          className={`relative inline-flex h-12 w-12 items-center justify-center border text-2xl ${
            isSuccess
              ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
              : "border-red-500/40 bg-red-500/10 text-red-500"
          }`}
          aria-hidden="true"
        >
          {isSuccess ? "✓" : "!"}
        </div>
        <p className="relative mt-5 text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          API OAuth callback
        </p>
        <h1 className="relative mt-2 max-w-2xl text-2xl font-semibold text-balance text-[var(--bo-fg)]">
          {isSuccess ? "Authentication complete" : "Authentication could not be completed"}
        </h1>
        <p className="relative mt-3 max-w-2xl text-sm text-pretty text-[var(--bo-muted)]">
          {isSuccess
            ? `Backoffice saved OAuth credentials${connectionSlug ? ` for ${connectionSlug}` : ""}.`
            : explanationFor(message)}
        </p>
      </div>

      <div className="grid gap-3 p-4 text-sm text-[var(--bo-muted)] md:grid-cols-2">
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Connection
          </p>
          <p className="mt-2 font-mono text-[var(--bo-fg)]">{connectionSlug ?? "unknown"}</p>
        </div>
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Organisation
          </p>
          <p className="mt-2 font-mono text-[var(--bo-fg)]">{orgId ?? "unknown"}</p>
        </div>
      </div>

      {!isSuccess ? (
        <div className="mx-4 mb-4 border border-red-500/40 bg-red-500/5 p-4">
          <p className="text-[10px] tracking-[0.22em] text-red-500 uppercase">Provider error</p>
          <p className="mt-2 text-sm text-red-100">{readableMessage(message)}</p>
          {code ? <p className="mt-3 font-mono text-xs text-red-400">{code}</p> : null}
        </div>
      ) : null}

      <div className="border-t border-[color:var(--bo-border)] p-4">
        {!isSuccess ? (
          <div className="mb-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 text-sm text-[var(--bo-muted)]">
            <p className="font-semibold text-[var(--bo-fg)]">Likely fix</p>
            <p className="mt-2">
              Recreate or update this API connection with token endpoint auth method{" "}
              <code className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-1 py-0.5 text-[var(--bo-fg)]">
                none
              </code>{" "}
              when using a PKCE public client, and omit the client secret.
            </p>
          </div>
        ) : null}
        <Link
          to={backUrl}
          className="inline-flex min-h-10 items-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-transform active:scale-[0.96]"
        >
          Back to connections
        </Link>
      </div>
    </section>
  );
}
