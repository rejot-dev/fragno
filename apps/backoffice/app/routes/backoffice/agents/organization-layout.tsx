import { Outlet, type ShouldRevalidateFunctionArgs } from "react-router";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";

import type { Route } from "./+types/organization-layout";
import { isPiConversationSubmission } from "./agent-conversation-submission";
import { loadPiLayoutData } from "./layout-data.server";
import { isPiAgentsPath } from "./path";
import { PiErrorBoundary, type PiLayoutContext } from "./shared";

export async function loader({ request, context }: Route.LoaderArgs) {
  return await loadPiLayoutData(request, context);
}

export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  return isPiConversationSubmission(formData) ? false : defaultShouldRevalidate;
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Agents · ${loaderData?.scopeLabel ?? "scope"}` }];
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <PiErrorBoundary error={error} params={params} />;
}

export default function BackofficeScopedPiLayout({ loaderData, matches }: Route.ComponentProps) {
  const { resolvedScope, scopeLabel, usageLabel, availableModelOptions, dictationMountRoute } =
    loaderData;
  const currentPath = matches[matches.length - 1]?.pathname ?? "";
  const isAgents = isPiAgentsPath(
    backofficeRouteScopeFromResolvedScope(resolvedScope),
    currentPath,
  );

  return (
    <div
      className={
        isAgents
          ? "flex h-[calc(100dvh-6.75rem)] min-h-0 flex-col gap-2 overflow-hidden sm:h-[calc(100dvh-4rem)]"
          : "space-y-4"
      }
    >
      <h1 className="sr-only">Agents for {scopeLabel}</h1>
      <div className={isAgents ? "flex min-h-0 flex-1 flex-col" : undefined}>
        <Outlet
          context={
            {
              resolvedScope,
              usageLabel,
              availableModelOptions,
              dictationMountRoute,
            } satisfies PiLayoutContext
          }
        />
      </div>
    </div>
  );
}
