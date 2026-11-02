import { ContextUsageMeter } from "./context-usage-meter";

export default { title: "Agents/Context usage meter" };

export function Readings() {
  return (
    <div className="flex flex-wrap items-center gap-4 bg-[var(--bo-panel-2)] p-3">
      <ContextUsageMeter tokens={18_400} contextWindow={200_000} />
      <ContextUsageMeter tokens={171_000} contextWindow={200_000} />
      <ContextUsageMeter tokens={212_000} contextWindow={200_000} />
      <ContextUsageMeter tokens={48_250} contextWindow={null} />
    </div>
  );
}
