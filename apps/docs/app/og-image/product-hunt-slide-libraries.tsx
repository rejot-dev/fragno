import { Cake } from "@/components/logos/cakes";
import { OG_LAYOUT, OG_SUBTITLE_TIGHT, OG_TITLE, OgSlideFrame } from "./slide-frame";

export function ProductHuntSlideLibraries() {
  return (
    <OgSlideFrame>
      <div className={OG_LAYOUT}>
        <div className="max-w-[820px] space-y-5">
          <h1 className={OG_TITLE}>Full-stack Libraries</h1>
          <p className={OG_SUBTITLE_TIGHT}>
            Fragments package database schemas, backend routes, and frontend hooks together.
          </p>
        </div>

        <div className={`mt-8`}>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-8">
            <div className="space-y-3">
              <div className="flex items-center gap-4 rounded-xl px-4 py-3">
                <Cake variant="cake-layer" layerVariant="top" className="h-16 w-16" />
                <p className="text-lg font-semibold text-red-900 dark:text-red-100">
                  Frontend hooks
                </p>
              </div>
              <div className="flex items-center gap-4 rounded-xl px-4 py-3">
                <Cake variant="cake-layer" layerVariant="middle" className="h-16 w-16" />
                <p className="text-lg font-semibold text-orange-900 dark:text-orange-100">
                  Backend routes
                </p>
              </div>
              <div className="flex items-center gap-4 rounded-xl px-4 py-3">
                <Cake variant="cake-layer" layerVariant="bottom" className="h-16 w-16" />
                <p className="text-lg font-semibold text-blue-900 dark:text-blue-100">DB schemas</p>
              </div>
            </div>

            <div className="text-6xl font-bold text-slate-400 dark:text-slate-500">→</div>

            <div className="flex justify-center">
              <Cake variant="cake-slice" className="h-[280px] w-[390px]" />
            </div>
          </div>
        </div>
      </div>
    </OgSlideFrame>
  );
}
