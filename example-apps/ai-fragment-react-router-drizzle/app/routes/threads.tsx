import type { Route } from "./+types/threads";

export function meta(_: Route.MetaArgs) {
  return [{ title: "AI Threads" }, { name: "description", content: "Explore AI fragment threads" }];
}

export default function Threads() {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <h1 className="text-2xl font-semibold text-slate-900">Threads</h1>
      <p className="mt-3 text-sm text-slate-600">
        Thread and run UI will live here. For now, use the API routes at
        <span className="font-mono"> /api/ai</span> to create threads, append messages, and stream
        runs.
      </p>
    </div>
  );
}
