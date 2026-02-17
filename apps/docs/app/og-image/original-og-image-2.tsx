import { FragnoLogo } from "@/components/logos/fragno-logo";
import { OgSlideFrame } from "./slide-frame";

export function OriginalOgImage() {
  const fragments = ["Auth", "Billing", "Forms", "Workflows"];

  return (
    <OgSlideFrame>
      <div className="relative z-10 flex h-full w-full flex-col justify-center px-20 py-16">
        <div className="flex items-center gap-4">
          <FragnoLogo className="h-20 w-24 text-slate-900 dark:text-white" />
          <p className="text-3xl font-semibold tracking-tight text-slate-800 dark:text-slate-100">
            Fragno
          </p>
        </div>

        <h1 className="mt-8 max-w-4xl text-7xl font-extrabold leading-[1.05] tracking-tight text-slate-900 dark:text-white">
          Integrate full-stack
          <br />
          libraries in minutes
        </h1>

        <p className="mt-6 max-w-5xl text-3xl leading-tight text-slate-600 dark:text-slate-300">
          Drop in auth, billing, forms, or workflows without stitching backend routes, database
          tables, and frontend hooks by hand.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          {fragments.map((fragment) => (
            <span
              key={fragment}
              className="rounded-full border border-slate-300/90 bg-white/90 px-5 py-2 text-2xl font-semibold text-slate-800 shadow-sm dark:border-slate-600/80 dark:bg-slate-800/70 dark:text-slate-100"
            >
              {fragment}
            </span>
          ))}
        </div>
      </div>
    </OgSlideFrame>
  );
}
