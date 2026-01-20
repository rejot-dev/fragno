import type { Route } from "./+types/home";

import { NavLink } from "react-router";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Fragno AI Fragment Example" },
    { name: "description", content: "Fragno AI fragment demo" },
  ];
}

export default function Home() {
  return (
    <main className="flex flex-col gap-12">
      <header className="grid gap-8 rounded-[32px] border border-slate-200 bg-gradient-to-br from-white via-slate-50 to-slate-200/70 p-10 shadow-sm lg:grid-cols-[1.2fr_0.8fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-slate-500">
            Fragno AI
          </p>
          <h1 className="mt-4 text-4xl font-semibold text-slate-900 lg:text-5xl">
            Durable AI runs with streams and artifacts.
          </h1>
          <p className="mt-4 max-w-2xl text-base text-slate-600">
            This example app is a starting point for the AI fragment. It keeps endpoints open for
            local debugging and gives you quick access to threads, runs, and streamed output.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <NavLink
              to="/threads"
              className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              View threads
            </NavLink>
            <a
              href="/api/ai/threads"
              className="rounded-full border border-slate-300 px-5 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400"
            >
              Open API index
            </a>
          </div>
        </div>
        <div className="rounded-2xl bg-slate-900 p-6 text-slate-100">
          <h2 className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-400">
            What you can do
          </h2>
          <ul className="mt-4 grid gap-3 text-sm text-slate-200">
            <li>Create threads with a system prompt and defaults.</li>
            <li>Append messages and stream foreground runs.</li>
            <li>Queue background runs and inspect events.</li>
            <li>Inspect deep research artifacts after webhooks land.</li>
          </ul>
        </div>
      </header>

      <section className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-2xl font-semibold text-slate-900">How it works</h2>
          <p className="mt-4 text-sm text-slate-600">
            The AI fragment exposes durable threads and runs over HTTP, plus client hooks for React
            state. This app keeps the API mounted at <span className="font-mono">/api/ai</span> so
            you can explore from the browser or curl.
          </p>
          <p className="mt-4 text-sm text-slate-600">
            Use the Threads view to add messages, kick off runs, and watch streaming output. The
            runner processes background work using an in-process dispatcher with polling.
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-slate-950 p-8 text-slate-100 shadow-sm">
          <h2 className="text-lg font-semibold">CLI quick start</h2>
          <p className="mt-2 text-sm text-slate-300">
            The AI fragment is mounted at <span className="font-mono">/api/ai</span>. Use the CLI to
            inspect threads or create runs from the terminal.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-900 p-4 text-sm text-slate-100">
            <code>fragno-ai threads list -b http://localhost:5173/api/ai</code>
          </pre>
        </div>
      </section>
    </main>
  );
}
