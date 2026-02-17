import { OG_CARD, OG_LAYOUT, OG_SUBTITLE, OG_TITLE, OgSlideFrame } from "./slide-frame";

const fragments = [
  {
    title: "Auth",
    detail: "User and session management",
    chip: "Auth",
    classes:
      "border-emerald-300/70 bg-emerald-100/70 text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-500/20 dark:text-emerald-100",
  },
  {
    title: "Billing",
    detail: "Stripe checkout + subscriptions",
    chip: "Billing",
    classes:
      "border-violet-300/70 bg-violet-100/70 text-violet-900 dark:border-violet-400/40 dark:bg-violet-500/20 dark:text-violet-100",
  },
  {
    title: "Workflows",
    detail: "Durable steps, retries, timers",
    chip: "Workflows",
    classes:
      "border-amber-300/70 bg-amber-100/70 text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/20 dark:text-amber-100",
  },
  {
    title: "Forms",
    detail: "Schema-driven forms + responses",
    chip: "Forms",
    classes:
      "border-sky-300/70 bg-sky-100/70 text-sky-900 dark:border-sky-400/40 dark:bg-sky-500/20 dark:text-sky-100",
  },
];

export function ProductHuntSlideFragments() {
  return (
    <OgSlideFrame>
      <div className={OG_LAYOUT}>
        <h1 className={OG_TITLE}>
          First Party Fragments
        </h1>
        <p className={OG_SUBTITLE}>
          Production-ready full-stack building blocks you can add in minutes.
        </p>

        <div className="mt-10 grid grid-cols-2 gap-5">
          {fragments.map((fragment) => (
            <div
              key={fragment.title}
              className={OG_CARD}
            >
              <div className="flex items-center justify-between">
                <h2 className="text-4xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100">
                  {fragment.title}
                </h2>
                <span className={`rounded-full border px-3 py-1 text-sm font-semibold ${fragment.classes}`}>
                  {fragment.chip}
                </span>
              </div>
              <p className="mt-3 text-xl text-slate-600 dark:text-slate-300">{fragment.detail}</p>
            </div>
          ))}
        </div>
      </div>
    </OgSlideFrame>
  );
}
