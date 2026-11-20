import { LeywayMark } from "./leyway-mark";
import { LeywayWordmark } from "./leyway-wordmark";

export default { title: "Brand/Leyway mark" };

export function Sizes() {
  return (
    <div className="flex items-end gap-6">
      <LeywayMark className="h-4 w-auto" />
      <LeywayMark className="h-8 w-auto" />
      <LeywayMark className="h-16 w-auto" />
    </div>
  );
}

export function WithWordmark() {
  return (
    <div className="flex items-center gap-3">
      <LeywayMark className="h-[calc(var(--spacing)*9*480/920)] w-auto" />
      <LeywayWordmark className="h-9" />
    </div>
  );
}
