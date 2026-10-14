import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useEffect } from "react";
import { Outlet, useOutletContext, useRevalidator } from "react-router";

import type { Route } from "./+types/sandboxes";
import type { ComputersLayoutContext, SandboxesLayoutContext } from "./layout-context";
import type { SandboxView } from "./sandbox-model";
import { isSandboxStatusTransitional } from "./sandbox-status";
import { requireScopedSandboxRuntime, toErrorMessage } from "./sandboxes.server";

type SandboxListLoad =
  | { status: "success"; sandboxes: SandboxView[] }
  | { status: "error"; message: string };

export function meta() {
  return [
    { title: "Sandboxes" },
    { name: "description", content: "Manage Cloudflare sandboxes for the selected scope." },
  ];
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { listSandboxes } = await requireScopedSandboxRuntime({ request, params, context });
  try {
    return { status: "success", sandboxes: await listSandboxes() } satisfies SandboxListLoad;
  } catch (error) {
    return { status: "error", message: toErrorMessage(error) } satisfies SandboxListLoad;
  }
}

export default function BackofficeSandboxes({ loaderData }: Route.ComponentProps) {
  const { routeScope } = useOutletContext<ComputersLayoutContext>();
  const sandboxes = loaderData.status === "success" ? loaderData.sandboxes : [];
  useRevalidateTransitionalSandboxes(sandboxes);

  if (loaderData.status === "error") {
    return (
      <BackofficeSystemState
        tone="error"
        label="Unavailable"
        title="Sandboxes could not be loaded."
        description={loaderData.message}
        flush
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 pt-4">
      <Outlet context={{ routeScope, sandboxes } satisfies SandboxesLayoutContext} />
    </div>
  );
}

// Polling lives in this layout so every page sees status changes while a sandbox settles.
function useRevalidateTransitionalSandboxes(sandboxes: SandboxView[]) {
  const revalidator = useRevalidator();
  const hasTransitionalSandbox = sandboxes.some((sandbox) =>
    isSandboxStatusTransitional(sandbox.status),
  );

  useEffect(() => {
    let timeoutId: number | undefined;
    if (hasTransitionalSandbox && revalidator.state === "idle") {
      timeoutId = window.setTimeout(() => void revalidator.revalidate(), 1_000);
    }

    return () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [hasTransitionalSandbox, revalidator]);
}
