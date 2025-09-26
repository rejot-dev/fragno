import { cn } from "@/lib/cn";
import { Cake } from "@/components/logos/cakes";

export default function BentoCake({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 p-4 md:grid-cols-2",
        className,
      )}
    >
      {/* Library - First on mobile, top-left on desktop */}
      <div className="bg-white/94 flex flex-col items-center justify-center rounded-2xl border p-6 md:order-1 dark:bg-slate-900/75">
        {/* Simple rows layout of three layers */}
        <div className="mb-4 flex flex-col pl-8">
          {/* Frontend */}
          <div className="flex items-center gap-4">
            <Cake variant="cake-layer" layerVariant="top" className="size-21" />
            <span className="text-s font-medium">Frontend</span>
          </div>

          {/* Backend */}
          <div className="flex items-center gap-4 pl-8">
            <Cake variant="cake-layer" layerVariant="middle" className="size-21" />
            <span className="text-s font-medium">Backend</span>
          </div>

          {/* Database */}
          <div className="flex items-center gap-4 pl-16">
            <Cake variant="cake-layer" layerVariant="bottom" className="size-21" />
            <span className="text-s font-medium">
              Database
              <br />
              <span className="text-fd-muted-foreground text-xs">(coming soon)</span>
            </span>
          </div>
        </div>
        <h3 className="mb-4 text-xl font-bold">Libraries</h3>
        <p className="text-s">
          Traditional libraries only target one layer of the stack; users are tasked with writing
          the glue code to tie it all together into an app.
        </p>
      </div>

      {/* Fragment - Second on mobile, bottom-left on desktop */}
      <div className="bg-white/94 flex flex-col items-center justify-center rounded-2xl border p-6 md:order-3 dark:bg-slate-900/75">
        <Cake variant="cake-slice" className="mx-auto size-48" />
        <h3 className="mb-4 text-xl font-bold">Fragno's Fragments</h3>
        <p className="text-s">
          With Fragno's fragments, library authors can target all layers without having to worry
          about the specifics of their end users' stack.
        </p>
      </div>

      {/* Application - Third on mobile, right column on desktop */}
      <div className="bg-white/94 flex flex-col items-center justify-center rounded-2xl border p-8 md:order-2 md:row-span-2 dark:bg-slate-900/75">
        <div className="space-y-4 text-center">
          <div className="text-gray-600 dark:text-gray-400">
            <Cake variant="cake-full" className="mx-auto size-72" />
          </div>
          <h3 className="text-2xl font-bold">Application</h3>
          <p className="text-s">
            Developers can use fragments to quickly build full-fledged applications with their
            framework of choice.
          </p>
        </div>
      </div>
    </div>
  );
}
