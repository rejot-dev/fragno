const stages = [
  { label: "EVENT", detail: "Something happens", tone: "bg-[var(--bo-live)]" },
  { label: "ROUTE", detail: "A path is selected", tone: "bg-[var(--bo-accent)]" },
  { label: "WORKFLOW", detail: "The work continues", tone: "bg-[var(--bo-waiting)]" },
  { label: "RESULT", detail: "The outcome remains", tone: "bg-[var(--bo-live)]" },
] as const;

export function WorkflowSection() {
  return (
    <section className="border-t border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-[clamp(1.25rem,7vw,7.5rem)] py-[clamp(4rem,8vw,8rem)]">
      <div className="mx-auto max-w-[1380px]">
        <div className="flex items-end justify-between gap-8 max-[700px]:block">
          <div>
            <span className="bo-product-code">FLOW / DURABLE</span>
            <h2 className="mt-5 max-w-3xl text-[clamp(2.6rem,5vw,5.5rem)] leading-[0.94] font-[520] tracking-[-0.065em] text-balance">
              From signal to action.
              <br />
              <span className="text-transparent [-webkit-text-stroke:1.25px_var(--bo-muted-2)]">
                Without losing the trail.
              </span>
            </h2>
          </div>
          <span className="mb-2 font-mono text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] max-[700px]:mt-6 max-[700px]:block">
            ORDERED / INSPECTABLE / RESUMABLE
          </span>
        </div>

        <div className="relative mt-16 grid grid-cols-4 border-y border-[color:var(--bo-border-strong)] max-[760px]:grid-cols-1">
          <div className="absolute top-1/2 right-0 left-0 h-px bg-[var(--bo-border-strong)] max-[760px]:top-0 max-[760px]:bottom-0 max-[760px]:left-8 max-[760px]:h-auto max-[760px]:w-px" />
          {stages.map((stage, index) => (
            <div
              key={stage.label}
              className="relative z-2 min-h-[180px] border-r border-[color:var(--bo-border)] p-5 last:border-r-0 max-[760px]:min-h-0 max-[760px]:border-r-0 max-[760px]:border-b max-[760px]:py-7 max-[760px]:pl-16"
            >
              <div className="flex items-center justify-between font-mono text-[9px] font-bold tracking-[0.18em] text-[var(--bo-muted-2)]">
                <span>{String(index + 1).padStart(2, "0")}</span>
                <span className="max-[760px]:hidden">{index < stages.length - 1 ? "→" : "■"}</span>
              </div>
              <div className="absolute top-1/2 left-5 flex -translate-y-1/2 items-center gap-3 bg-[var(--bo-panel-2)] pr-4 max-[760px]:top-1/2 max-[760px]:left-[27px] max-[760px]:p-0">
                <i className={`size-[10px] ${stage.tone} shadow-[0_0_0_5px_var(--bo-panel-2)]`} />
              </div>
              <div className="absolute right-5 bottom-5 left-5 max-[760px]:static max-[760px]:mt-4">
                <h3 className="text-xs font-bold tracking-[0.16em]">{stage.label}</h3>
                <p className="mt-2 text-xs text-[var(--bo-muted)]">{stage.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
