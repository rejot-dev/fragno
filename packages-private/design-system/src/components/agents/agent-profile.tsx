import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Who an agent is and what it may use, in one column: its whole description, the facts that shape
 * its turns, its instructions, and the skills it finds.
 */
export function AgentProfile({
  displayName,
  description,
  category,
  maintainer,
  model,
  reasoning,
  permissions,
  instructions,
  skills,
}: {
  displayName: string;
  description: string;
  /** Null for an assistant. */
  category: string | null;
  maintainer: string;
  /** The model it runs, such as "GPT-6.1 Sol", or how it picks one. */
  model: string;
  reasoning: string;
  permissions: readonly string[];
  /** Its rendered instructions; null when it has none. */
  instructions: ReactNode | null;
  skills: ReactNode;
}) {
  return (
    <article className="max-w-4xl">
      <header>
        <h2 className="text-xl font-semibold tracking-[-0.02em] text-balance text-[var(--bo-fg)]">
          {displayName}
        </h2>
        <p className="mt-0.5 text-sm text-[var(--bo-muted-2)]">
          {category ?? "Assistant"}
          <span aria-hidden="true" className="mx-2 text-[var(--bo-border-strong)]">
            /
          </span>
          {maintainer}
        </p>
      </header>

      <p className="mt-5 text-[15px] leading-7 text-pretty text-[var(--bo-fg)]">{description}</p>

      <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-3 border-y border-[color:var(--bo-border)] py-3 text-sm">
        <Fact label="Model">{model}</Fact>
        <Fact label="Reasoning">{reasoning}</Fact>
        <Fact label="Permissions">
          {permissions.includes("*") ? (
            "Whatever its prompter may do"
          ) : (
            <span className="flex flex-wrap gap-1">
              {permissions.map((grant) => (
                <code
                  key={grant}
                  className="bg-[var(--bo-panel-2)] px-1.5 py-0.5 font-mono text-[11px] shadow-[inset_0_0_0_1px_var(--bo-border)]"
                >
                  {grant}
                </code>
              ))}
            </span>
          )}
        </Fact>
      </dl>

      <ProfileSection title="Instructions">
        {instructions === null ? (
          <p className="text-sm text-[var(--bo-muted)]">
            None: it follows Leyway&apos;s guidance alone.
          </p>
        ) : (
          <Clamped>{instructions}</Clamped>
        )}
      </ProfileSection>

      <ProfileSection title="Skills">
        <p className="mb-3 max-w-2xl text-xs leading-5 text-pretty text-[var(--bo-muted)]">
          The agent is told the name and description of each skill it is offered, and reads the rest
          when its work calls for it. It is not told about the others, though it can still read
          them.
        </p>
        {skills}
      </ProfileSection>
    </article>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[var(--bo-muted-2)]">{label}</dt>
      <dd className="mt-0.5 text-[var(--bo-fg)]">{children}</dd>
    </div>
  );
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-8">
      <h3 className="mb-3 text-sm font-semibold text-[var(--bo-fg)]">{title}</h3>
      {children}
    </section>
  );
}

/** Content cut to a few lines, with a toggle when there is more. */
function Clamped({ children }: { children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    // The ref is set before layout effects run.
    const element = content.current!;
    const measure = () => {
      setOverflows(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div>
      <div
        ref={content}
        className={`relative text-sm leading-6 text-[var(--bo-fg)] ${open ? "" : "max-h-36 overflow-hidden"} ${!open && overflows ? "[mask-image:linear-gradient(to_bottom,black_60%,transparent)]" : ""}`}
      >
        {children}
      </div>
      {overflows || open ? (
        <button
          type="button"
          onClick={() => {
            setOpen((current) => !current);
          }}
          className="mt-1 cursor-pointer text-xs font-semibold text-[var(--bo-accent-fg)] hover:underline"
        >
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}
