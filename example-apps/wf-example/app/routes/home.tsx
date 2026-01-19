import type { Route } from "./+types/home";

import { NavLink } from "react-router";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Workflow Fragment Example" },
    { name: "description", content: "Fragno workflows fragment demo" },
  ];
}

export default function Home() {
  return (
    <main className="flex flex-col gap-12">
      <header className="grid gap-8 rounded-[32px] border border-slate-200 bg-gradient-to-br from-white via-slate-50 to-slate-200/70 p-10 shadow-sm lg:grid-cols-[1.2fr_0.8fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-slate-500">
            Fragno workflows
          </p>
          <h1 className="mt-4 text-4xl font-semibold text-slate-900 lg:text-5xl">
            Workflow fragments, fully observable.
          </h1>
          <p className="mt-4 max-w-2xl text-base text-slate-600">
            This example app showcases the client-side hooks for the workflow fragment. Browse
            instances, drill into history, and send events without touching the backend directly.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <NavLink
              to="/instances"
              className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Explore instances
            </NavLink>
            <NavLink
              to="/create-instance"
              className="rounded-full border border-slate-300 px-5 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400"
            >
              Create a new run
            </NavLink>
          </div>
        </div>
        <div className="rounded-2xl bg-slate-900 p-6 text-slate-100">
          <h2 className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-400">
            What you can do
          </h2>
          <ul className="mt-4 grid gap-3 text-sm text-slate-200">
            <li>Filter instances by workflow type.</li>
            <li>Inspect run metadata and step history.</li>
            <li>Send events to advance or pause workflows.</li>
            <li>Manage lifecycle actions (pause, resume, restart).</li>
          </ul>
        </div>
      </header>

      <section className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-2xl font-semibold text-slate-900">How it works</h2>
          <p className="mt-4 text-sm text-slate-600">
            The workflow fragment exposes an API and a client package. The hooks you see here are
            typed, cache-aware, and support invalidation so the UI stays in sync with the backend.
          </p>
          <p className="mt-4 text-sm text-slate-600">
            Navigate to the Instances page to explore running workflows or open the Create page to
            start a new run with custom parameters.
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-slate-950 p-8 text-slate-100 shadow-sm">
          <h2 className="text-lg font-semibold">CLI quick start</h2>
          <p className="mt-2 text-sm text-slate-300">
            The workflows fragment is mounted at <span className="font-mono">/api/workflows</span>.
            Use the CLI to inspect runs or send events from the terminal.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-900 p-4 text-sm text-slate-100">
            <code>fragno-wf workflows list -b http://localhost:5173/api/workflows</code>
          </pre>
        </div>
      </section>
    </main>
  );
}
