import type { ReactNode } from "react";

export function WelcomeShell({ children }: { children: ReactNode }) {
  return (
    <main className="relative isolate">
      <div className="pointer-events-none absolute inset-0 -z-10 opacity-60 [mask-image:radial-gradient(60%_60%_at_50%_20%,black,transparent)]">
        <div className="h-full w-full bg-gradient-to-b from-blue-50 via-transparent to-transparent dark:from-blue-950" />
      </div>
      {children}
    </main>
  );
}

export function WelcomeHero() {
  return (
    <section className="mx-auto max-w-5xl px-6 pb-8 pt-16 sm:pt-20">
      <div className="inline-flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1 text-xs text-gray-600 backdrop-blur dark:border-gray-800 dark:text-gray-300">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        Experimental • Fragno
      </div>

      <h1 className="mt-6 text-balance text-5xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">
        <span className="bg-gradient-to-r from-blue-600 via-purple-600 to-rose-600 bg-clip-text text-transparent">
          Fragno
        </span>{" "}
        — Composable web primitives
      </h1>
      <p className="mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-gray-600 dark:text-gray-300">
        A tiny, strongly‑typed foundation for building web apps. Keep the core generic; add
        framework adapters only where they belong.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <a
          href="https://github.com/rejot-dev/fragno/tree/main/ai-docs"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 dark:focus:ring-offset-gray-950"
        >
          Get Started
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4"
          >
            <path
              fillRule="evenodd"
              d="M10.293 3.293a1 1 0 011.414 0l5 5a1 1 0 010 1.414l-5 5a1 1 0 11-1.414-1.414L13.586 11H4a1 1 0 110-2h9.586l-3.293-3.293a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </a>
        <a
          href="https://github.com/rejot-dev/fragno"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-200 dark:hover:bg-gray-900"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.64 0 8.13c0 3.59 2.29 6.63 5.47 7.7.4.08.55-.18.55-.39 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.5-2.69-.96-.09-.23-.48-.96-.82-1.15-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.53.28-.87.51-1.07-1.78-.2-3.64-.92-3.64-4.08 0-.9.31-1.64.82-2.22-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.84.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.1.16 1.92.08 2.12.51.58.82 1.32.82 2.22 0 3.17-1.87 3.88-3.65 4.08.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.47.55.39A8.04 8.04 0 0016 8.13C16 3.64 12.42 0 8 0Z" />
          </svg>
          Star on GitHub
        </a>
      </div>
    </section>
  );
}

export function WelcomeExperiments() {
  const experiments = [
    {
      title: "Core + Adapters",
      description: "Framework‑agnostic core with thin React/Vanilla adapters.",
      icon: "🧩",
    },
    {
      title: "Typed Client Builder",
      description: "Generate ergonomic, typed client hooks and stores.",
      icon: "🧪",
    },
    {
      title: "File‑based API",
      description: "Minimal API surfaces with composable routing primitives.",
      icon: "🗂️",
    },
    {
      title: "Tiny Runtime",
      description: "Small, explicit primitives over heavy abstractions.",
      icon: "✨",
    },
    {
      title: "First‑class DX",
      description: "Great defaults, strict types, zero magic.",
      icon: "⚙️",
    },
    {
      title: "Chatno Integration",
      description: "Seamless AI assistant tooling built on the same core.",
      icon: "🤖",
    },
  ];

  return (
    <section className="mx-auto max-w-5xl px-6 pb-16">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {experiments.map((item) => (
          <div
            key={item.title}
            className="group relative overflow-hidden rounded-2xl border border-gray-200 bg-white/60 p-4 shadow-sm backdrop-blur transition dark:border-gray-800 dark:bg-gray-900/60"
          >
            <div className="absolute inset-0 -z-10 bg-gradient-to-br from-transparent via-transparent to-blue-50 opacity-0 transition group-hover:opacity-100 dark:to-blue-950" />
            <div className="flex items-start gap-3">
              <div className="text-2xl leading-none">{item.icon}</div>
              <div>
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  {item.title}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                  {item.description}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
