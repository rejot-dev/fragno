/**
 * The stories the landing page's dashboard plays, one after another: in each, a request is typed
 * into the agent drawer and sent, the agent works, replies, and the dashboard shows the result. The
 * first opens the drawer; the rest keep it open.
 * They follow each other: the tools connected first serve the automation last.
 */
export type DashboardDemoId = "connect" | "page" | "automate";

type DashboardDemo = {
  id: DashboardDemoId;
  title: string;
  prompt: string;
  /** When each of the agent's steps starts; the last runs until the work ends. */
  stepStarts: readonly number[];
  /** When a provider's permission prompt opens, is approved, and closes, for stories that have one. */
  consent: { opens: number; approves: number; closes: number } | null;
  /** How far into the beat the part starts: later parts skip the drawer opening. */
  startsAt: number;
  /** How long the part plays, from its start until the next part takes over. */
  durationMs: number;
};

// When each beat starts, in milliseconds from a story's start; every story keeps the same beat.
const DRAWER_OPENS = 1200;
const TYPING_STARTS = 2000;
const TYPING_ENDS = 4200;
const SENT = 4600;
const WORK_STARTS = 5000;
const WORK_ENDS = 9400;
const REPLIED = 9800;
const RESULT_SHOWN = 10_400;
// Each part moves on this soon after its result shows; the last holds longer before the loop.
const RESULT_HOLD = 2600;
const LAST_RESULT_HOLD = 4800;
// Later parts begin just before their typing does, the drawer being open already.
const CONTINUING_START = TYPING_STARTS - 400;

export const DASHBOARD_DEMOS: readonly DashboardDemo[] = [
  {
    id: "connect",
    title: "Connect your tools",
    prompt: "Connect our Google Drive and Slack.",
    // Google Drive waits on its permission prompt; Slack follows once it is approved.
    stepStarts: [WORK_STARTS, 5800, 8400],
    consent: { opens: 6200, approves: 7600, closes: 8200 },
    startsAt: 0,
    durationMs: RESULT_SHOWN + RESULT_HOLD,
  },
  {
    id: "page",
    title: "Build a page",
    prompt: "Make a page with this week's signups by plan.",
    stepStarts: [WORK_STARTS, 5800, 8800],
    consent: null,
    startsAt: CONTINUING_START,
    durationMs: RESULT_SHOWN - CONTINUING_START + RESULT_HOLD,
  },
  {
    id: "automate",
    title: "Automate the work",
    prompt: "When someone signs up on the Business plan, tell #sales on Slack.",
    stepStarts: [WORK_STARTS, 5800, 8800],
    consent: null,
    startsAt: CONTINUING_START,
    durationMs: RESULT_SHOWN - CONTINUING_START + LAST_RESULT_HOLD,
  },
];

export type DashboardDemoScene = {
  demo: DashboardDemoId;
  drawerOpen: boolean;
  /** What the composer holds: the request as typed so far, empty once sent. */
  draft: string;
  sent: boolean;
  work: "none" | "running" | "done";
  /** The agent's step under way while it works. */
  step: number;
  consent: "closed" | "open" | "approving";
  replied: boolean;
  resultShown: boolean;
};

/** What part `index` shows `played` milliseconds after it starts. */
export function sceneAt(index: number, played: number): DashboardDemoScene {
  const { id, prompt, stepStarts, consent, startsAt } =
    DASHBOARD_DEMOS[index] ?? DASHBOARD_DEMOS[0];
  // The beat's clock, which later parts join partway.
  const elapsed = played + startsAt;
  const typed = Math.round(
    prompt.length *
      Math.min(1, Math.max(0, (elapsed - TYPING_STARTS) / (TYPING_ENDS - TYPING_STARTS))),
  );
  const sent = elapsed >= SENT;
  return {
    demo: id,
    // The first story opens the drawer; the stories after it continue with it open.
    drawerOpen: index > 0 || elapsed >= DRAWER_OPENS,
    draft: sent ? "" : prompt.slice(0, typed),
    sent,
    work: elapsed >= WORK_ENDS ? "done" : elapsed >= WORK_STARTS ? "running" : "none",
    // The starts are in order, so the step under way is the last of those that have started.
    step: Math.max(0, stepStarts.filter((start) => elapsed >= start).length - 1),
    consent:
      consent === null || elapsed < consent.opens || elapsed >= consent.closes
        ? "closed"
        : elapsed >= consent.approves
          ? "approving"
          : "open",
    replied: elapsed >= REPLIED,
    resultShown: elapsed >= RESULT_SHOWN,
  };
}

/** How long part `index` plays before the next takes over. */
export function durationOf(index: number): number {
  return (DASHBOARD_DEMOS[index] ?? DASHBOARD_DEMOS[0]).durationMs;
}

export function promptOf(id: DashboardDemoId): string {
  return DASHBOARD_DEMOS.find((demo) => demo.id === id)?.prompt ?? "";
}
