import { BackofficeStatusLight } from "../feedback/status-light";
import { Icon } from "../icon";

/** Where the agent found a skill: Leyway's, the workspace's, or a folder its definition names. */
export type AgentSkillSource =
  | { kind: "static" }
  | { kind: "workspace" }
  | { kind: "folder"; folder: string };

/**
 * Whether the agent is offered the skill: disabled by its definition, hidden by its own
 * frontmatter, so read only where something names it, or replaced by a skill of the same name.
 */
export type AgentSkillStatus =
  | { kind: "offered" }
  | { kind: "disabled" }
  | { kind: "hidden" }
  | { kind: "replaced"; by: string };

export type AgentSkill = {
  name: string;
  description: string;
  location: string;
  source: AgentSkillSource;
  status: AgentSkillStatus;
};

type SkillGroup = { key: string; title: string; detail: string; skills: AgentSkill[] };

/** A group this small names every skill in its summary; a larger one only those not offered. */
const NAMED_IN_SUMMARY = 6;

/** A folder under `/shared/<name>/` is a share this scope accepted under that name. */
function sharedFolderName(folder: string) {
  return /^\/shared\/([^/]+)(?:\/|$)/u.exec(folder)?.[1] ?? null;
}

function groupOf(source: AgentSkillSource): Omit<SkillGroup, "skills"> {
  if (source.kind === "static") {
    return { key: "static", title: "Built in", detail: "/static/skills" };
  }
  if (source.kind === "workspace") {
    return { key: "workspace", title: "This workspace", detail: "/workspace/**/skills" };
  }
  const share = sharedFolderName(source.folder);
  return {
    key: `folder:${source.folder}`,
    title: share === null ? "Folder" : `Shared from ${share}`,
    detail: source.folder,
  };
}

/**
 * Skills in groups by where they were found, built-in skills first, as the agent is offered them.
 * In each group, skills the agent is not offered come first, so a disabled one is seen at once.
 */
function groupSkills(skills: readonly AgentSkill[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  const notOfferedFirst = [...skills].sort(
    (left, right) =>
      Number(left.status.kind === "offered") - Number(right.status.kind === "offered"),
  );
  for (const skill of notOfferedFirst) {
    const group = groupOf(skill.source);
    const existing = groups.get(group.key) ?? { ...group, skills: [] };
    existing.skills.push(skill);
    groups.set(group.key, existing);
  }
  return [...groups.values()];
}

/**
 * Every skill an agent finds, one line per group: how many it is offered, and by name those it is
 * not, with why, so a disabled skill reads as a choice rather than as missing. A group opens to a
 * line per skill. `problems` are files and folders the agent could not use.
 */
export function AgentSkillList({
  skills,
  problems,
}: {
  skills: readonly AgentSkill[];
  problems: readonly { path: string; message: string }[];
}) {
  const groups = groupSkills(skills);
  return (
    <div className="@container/skills divide-y divide-[color:var(--bo-border)] border-y border-[color:var(--bo-border)]">
      {groups.length === 0 ? (
        <p className="py-3 text-sm text-[var(--bo-muted)]">This agent finds no skills.</p>
      ) : (
        groups.map((group) => <SkillGroupRow key={group.key} group={group} />)
      )}
      {problems.length === 0 ? null : <SkillProblems problems={problems} />}
    </div>
  );
}

function SkillGroupRow({ group }: { group: SkillGroup }) {
  const offered = group.skills.filter((skill) => skill.status.kind === "offered").length;
  const named =
    group.skills.length <= NAMED_IN_SUMMARY
      ? group.skills
      : group.skills.filter((skill) => skill.status.kind !== "offered");
  const unnamed = group.skills.length - named.length;
  return (
    <details className="group/skills">
      <summary className="flex cursor-pointer list-none flex-wrap items-start gap-x-4 gap-y-2 py-3 @xl/skills:flex-nowrap [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 @xl/skills:w-52 @xl/skills:flex-none">
          <span className="block text-sm font-semibold text-[var(--bo-fg)]">{group.title}</span>
          <span className="block text-xs text-[var(--bo-muted-2)] tabular-nums">
            {offered} of {group.skills.length} offered
          </span>
        </span>
        <span className="order-last flex min-w-0 basis-full flex-wrap items-center gap-1.5 @xl/skills:order-none @xl/skills:flex-1 @xl/skills:basis-auto @xl/skills:pt-0.5">
          {named.map((skill) => (
            <SkillChip key={skill.location} skill={skill} />
          ))}
          {unnamed === 0 || named.length === 0 ? null : (
            <span className="text-xs text-[var(--bo-muted)]">and {unnamed} more</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1 pt-0.5 text-xs font-semibold text-[var(--bo-accent-fg)]">
          <span className="group-open/skills:hidden">Show</span>
          <span className="hidden group-open/skills:inline">Hide</span>
          <Icon
            name="chevron-down"
            className="size-3.5 transition-transform duration-150 ease-out group-open/skills:rotate-180"
          />
        </span>
      </summary>
      <div className="pb-3 @xl/skills:pl-56">
        <p className="mb-1 font-mono text-[11px] break-all text-[var(--bo-muted-2)]">
          {group.detail}
        </p>
        <ul>
          {group.skills.map((skill) => (
            <li key={skill.location}>
              <SkillLine skill={skill} />
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/** A skill's name, toned by whether the agent is offered it, with why not. */
function SkillChip({ skill }: { skill: AgentSkill }) {
  const { status } = skill;
  if (status.kind === "offered") {
    return (
      <span
        title={skill.description}
        className="inline-flex min-h-6 items-center rounded-[4px] bg-[var(--bo-panel-2)] px-2 text-xs font-medium text-[var(--bo-fg)] shadow-[inset_0_0_0_1px_var(--bo-border)]"
      >
        {skill.name}
      </span>
    );
  }
  return (
    <span title={status.kind === "replaced" ? `Replaced by ${status.by}` : skill.description}>
      <BackofficeStatusLight tone={status.kind === "disabled" ? "waiting" : "muted"} dot={false}>
        <span className="font-medium">{skill.name}</span>
        <span className="font-normal opacity-80">{notOfferedReason(status)}</span>
      </BackofficeStatusLight>
    </span>
  );
}

function SkillLine({ skill }: { skill: AgentSkill }) {
  const { status } = skill;
  const offered = status.kind === "offered";
  return (
    <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-baseline gap-x-3 py-1 text-xs">
      <span
        className={`truncate font-semibold ${offered ? "text-[var(--bo-fg)]" : "text-[var(--bo-muted)]"}`}
      >
        {skill.name}
      </span>
      <span
        title={skill.description}
        className={`truncate ${offered ? "text-[var(--bo-muted)]" : "text-[var(--bo-muted-2)]"}`}
      >
        {skill.description}
      </span>
      <span
        className={
          status.kind === "disabled"
            ? "font-semibold text-[var(--bo-waiting)]"
            : "text-[var(--bo-muted-2)]"
        }
      >
        {offered ? null : notOfferedReason(status)}
      </span>
    </div>
  );
}

function notOfferedReason(status: Exclude<AgentSkillStatus, { kind: "offered" }>) {
  if (status.kind === "disabled") {
    return "disabled";
  }
  if (status.kind === "hidden") {
    return "only where named";
  }
  return `replaced by ${replacementSource(status.by)}`;
}

/** Whose skill of the same name the agent is offered instead, by where its file is. */
function replacementSource(location: string) {
  if (location.startsWith("/workspace/")) {
    return "this workspace's";
  }
  const share = sharedFolderName(location);
  return share === null ? location : `${share}'s`;
}

function SkillProblems({ problems }: { problems: readonly { path: string; message: string }[] }) {
  return (
    <details className="group/problems">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-3 [&::-webkit-details-marker]:hidden">
        <BackofficeStatusLight tone="waiting">
          {problems.length === 1 ? "1 problem" : `${problems.length} problems`}
        </BackofficeStatusLight>
        <Icon
          name="chevron-down"
          className="size-3.5 text-[var(--bo-muted-2)] transition-transform duration-150 ease-out group-open/problems:rotate-180"
        />
      </summary>
      <ul className="space-y-1 pb-3 text-xs">
        {problems.map((problem) => (
          <li key={`${problem.path}:${problem.message}`} className="text-pretty">
            <code className="font-mono text-[11px] break-all text-[var(--bo-muted)]">
              {problem.path}
            </code>{" "}
            <span className="text-[var(--bo-fg)]">{problem.message}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
