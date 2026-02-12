import { cn } from "@/lib/cn";
import { FragnoCodeBlock } from "@/components/fragno-code-block";

type SkillCtaProps = {
  title: string;
  command: string;
  description: string;
  className?: string;
  eyebrow?: string;
};

export function SkillCta({
  title,
  command,
  description,
  className,
  eyebrow = "Assistant Skill",
}: SkillCtaProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-black/5 bg-white/90 p-6 shadow-sm dark:border-white/10 dark:bg-slate-950/60",
        className,
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {eyebrow}
      </p>
      <h3 className="mt-2 text-lg font-semibold text-slate-900 dark:text-white">{title}</h3>
      <div className="mt-4">
        <FragnoCodeBlock lang="bash" code={command} allowCopy className="rounded-xl" />
      </div>
      <p className="text-fd-muted-foreground mt-3 text-sm">{description}</p>
    </div>
  );
}
