import type { Route } from "./+types/create-instance";

import { ClientOnly } from "~/components/client-only";
import { CreateInstanceForm } from "~/workflows/create-instance-form";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Create Workflow Instance" },
    { name: "description", content: "Start a new workflow run" },
  ];
}

export default function CreateInstanceRoute() {
  return (
    <section className="grid gap-6">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.35em] text-slate-400">Create</p>
        <h1 className="text-3xl font-semibold text-slate-900">Create a workflow instance</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Provide a workflow type and payload to start a new run. You can watch it live from the
          Instances page.
        </p>
      </header>

      <ClientOnly fallback={<p className="text-sm text-slate-500">Loading form…</p>}>
        <CreateInstanceForm />
      </ClientOnly>
    </section>
  );
}
