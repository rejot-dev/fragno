const files = [
  { depth: 0, label: "workspace", type: "folder", active: false },
  { depth: 1, label: "automations", type: "folder", active: false },
  { depth: 2, label: "triage.ts", type: "file", active: true },
  { depth: 2, label: "daily-brief.ts", type: "file", active: false },
  { depth: 1, label: "context", type: "folder", active: false },
  { depth: 2, label: "event.json", type: "file", active: false },
] as const;

export function WorkspaceSection() {
  return (
    <section className="border-t border-[color:var(--bo-border)] bg-[var(--bo-bg)] px-[clamp(1.25rem,7vw,7.5rem)] py-[clamp(4rem,8vw,8rem)]">
      <div className="mx-auto grid max-w-[1380px] grid-cols-[0.72fr_1.28fr] items-center gap-[clamp(3rem,8vw,8rem)] max-[900px]:grid-cols-1">
        <div>
          <span className="bo-product-code">FILES / CONTEXT</span>
          <h2 className="mt-5 text-[clamp(2.6rem,5vw,5.5rem)] leading-[0.94] font-[520] tracking-[-0.065em] text-balance">
            Code and context,
            <br />
            <span className="text-[var(--bo-muted-2)]">side by side.</span>
          </h2>
          <p className="mt-6 max-w-md text-sm leading-6 text-pretty text-[var(--bo-muted)]">
            Browse mounted files, inspect inputs, and shape durable work in the same place.
          </p>
          <div className="mt-8 flex flex-wrap gap-x-8 gap-y-3 font-mono text-[9px] font-bold tracking-[0.16em] text-[var(--bo-muted-2)]">
            <span>/ WORKSPACE</span>
            <span>/ EVENTS</span>
            <span>/ PROVIDERS</span>
          </div>
        </div>

        <div className="bo-panel-surface bo-fragment-surface relative min-h-[470px] border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] max-[560px]:min-h-[400px]">
          <div className="flex h-11 items-center justify-between border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 font-mono text-[8px] font-bold tracking-[0.18em] text-[var(--bo-muted-2)]">
            <span>WORKSPACE / AUTOMATIONS</span>
            <span className="text-[var(--bo-live)]">● READY</span>
          </div>
          <div className="grid min-h-[425px] grid-cols-[190px_1fr] max-[560px]:grid-cols-[130px_1fr]">
            <div className="border-r border-[color:var(--bo-border)] py-3 font-mono text-[9px] text-[var(--bo-muted)]">
              {files.map((file) => (
                <div
                  key={file.label}
                  className={`flex h-8 items-center gap-2 border-l-2 pr-2 ${file.active ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-fg)]" : "border-transparent"}`}
                  style={{ paddingLeft: `${12 + file.depth * 12}px` }}
                >
                  <span
                    className={
                      file.type === "folder"
                        ? "text-[var(--bo-accent)]"
                        : "text-[var(--bo-muted-2)]"
                    }
                  >
                    {file.type === "folder" ? "▾" : "·"}
                  </span>
                  <span className="truncate">{file.label}</span>
                </div>
              ))}
            </div>
            <div className="relative overflow-hidden p-5 font-mono text-[10px] leading-6 text-[var(--bo-muted)] max-[560px]:p-3 max-[560px]:text-[8px]">
              <div className="absolute top-0 bottom-0 left-11 w-px bg-[var(--bo-border)] max-[560px]:left-8" />
              <CodeLine number="1">
                <span className="text-[var(--bo-accent)]">export</span>{" "}
                <span className="text-[var(--bo-fg)]">default</span> workflow(
              </CodeLine>
              <CodeLine number="2" indent>
                <span className="text-[var(--bo-live)]">"triage"</span>,
              </CodeLine>
              <CodeLine number="3" indent>
                <span className="text-[var(--bo-accent)]">async</span> ({` event, files `}) =&gt;{" "}
                {`{`}
              </CodeLine>
              <CodeLine number="4" doubleIndent>
                <span className="text-[var(--bo-fg)]">const</span> brief ={" "}
                <span className="text-[var(--bo-accent)]">await</span>
              </CodeLine>
              <CodeLine number="5" doubleIndent>
                files.read(<span className="text-[var(--bo-live)]">"/context/event.json"</span>)
              </CodeLine>
              <CodeLine number="6" />
              <CodeLine number="7" doubleIndent>
                <span className="text-[var(--bo-accent)]">return</span> route(brief)
              </CodeLine>
              <CodeLine number="8" indent>
                {`}`},
              </CodeLine>
              <CodeLine number="9">)</CodeLine>

              <div className="absolute right-4 bottom-4 left-16 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 max-[560px]:left-10">
                <div className="mb-2 flex items-center justify-between text-[8px] tracking-[0.16em] text-[var(--bo-muted-2)]">
                  <span>LAST RUN</span>
                  <span className="text-[var(--bo-live)]">COMPLETED</span>
                </div>
                <div className="h-1 bg-[var(--bo-border)]">
                  <div className="h-full w-4/5 bg-[var(--bo-accent)]" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function CodeLine({
  number,
  indent = false,
  doubleIndent = false,
  children,
}: {
  number: string;
  indent?: boolean;
  doubleIndent?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[28px_1fr] max-[560px]:grid-cols-[20px_1fr]">
      <span className="text-[var(--bo-muted-2)]">{number}</span>
      <span className={doubleIndent ? "pl-8" : indent ? "pl-4" : ""}>{children}</span>
    </div>
  );
}
