import type { Route } from "./+types/instances";

import { ClientOnly } from "~/components/client-only";
import { InstancesView } from "~/workflows/instances-view";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Workflow Instances" },
    { name: "description", content: "Browse workflow instances" },
  ];
}

export default function InstancesRoute() {
  return (
    <section className="grid gap-6">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.35em] text-slate-400">
          Instances
        </p>
        <h1 className="text-3xl font-semibold text-slate-900">Workflow instances</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Select a workflow type, then drill into any instance to see details, history, and events.
        </p>
      </header>

      <ClientOnly fallback={<p className="text-sm text-slate-500">Loading instances…</p>}>
        <InstancesView />
      </ClientOnly>
    </section>
  );
}
