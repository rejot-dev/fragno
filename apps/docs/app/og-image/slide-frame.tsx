import type { ReactNode } from "react";

export const OG_LAYOUT = "relative z-10 flex w-full flex-col px-16 py-14";
export const OG_TITLE =
  "text-6xl leading-[1.05] font-extrabold tracking-tight text-slate-900 dark:text-white";
export const OG_SUBTITLE =
  "mt-4 max-w-4xl text-2xl leading-tight text-slate-600 dark:text-slate-300";
export const OG_SUBTITLE_TIGHT =
  "max-w-4xl text-2xl leading-tight text-slate-600 dark:text-slate-300";
export const OG_CARD =
  "rounded-2xl border border-slate-200/70 bg-white/85 p-6 shadow-sm dark:border-slate-700/70 dark:bg-slate-900/75";
export const OG_PANEL =
  "rounded-3xl border border-slate-200/70 bg-white/85 p-8 shadow-xl backdrop-blur-sm dark:border-slate-700/70 dark:bg-slate-900/75";
export const OG_CODE_BLOCK =
  "rounded-xl border border-slate-800/10 bg-slate-950 px-5 py-4 font-mono text-xl text-slate-100 dark:border-white/15";
export const OG_LABEL =
  "text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-300";
export const OG_LIST = "mt-3 space-y-2 text-xl text-slate-700 dark:text-slate-200";

export function OgSlideFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex h-[630px] w-[1200px] overflow-hidden bg-white/50 dark:bg-slate-900">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="bg-linear-to-br mx-auto -mt-20 h-[520px] w-[1000px] from-blue-500 via-sky-400 to-purple-500 opacity-10 blur-3xl dark:opacity-25" />
      </div>
      {children}
    </div>
  );
}
