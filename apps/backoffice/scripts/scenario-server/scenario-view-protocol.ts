// What the scenario server and its view (control-view.ts) send each other.

/** An element of the app's page: the one a CSS selector matches, or the innermost showing text. */
export type ScenarioViewTarget = { selector: string } | { text: string };

/** What a scenario step has the view do to the app's page, which the view acknowledges. */
export type ScenarioViewCommand =
  | { kind: "navigate"; path: string }
  | { kind: "highlight"; target: ScenarioViewTarget; caption: string }
  | { kind: "click"; target: ScenarioViewTarget };

/** A step that drives the view's page, or an operation in the scenario's runtime. */
export type ScenarioViewStep = { label: string; kind: "view" | "operation" };

/** A row an outbox recorded a step changing, in the scope whose Automations it is in. */
export type ScenarioViewChange = {
  scope: string;
  op: "create" | "update" | "delete" | "truncate";
  table: string;
  id: string;
  values: Record<string, unknown>;
};

/** What a step does: the scenario step it runs, and the rows it changes. */
export type ScenarioViewExplanation = {
  does: { type: string; label: string };
  changes: ScenarioViewChange[];
};

export type ScenarioViewState = {
  /** How often the scenario was reset; a new one runs from a new runtime. */
  generation: number;
  name: string;
  /** By their place in the journal, which /__scenario/ran/:index explains. */
  ran: readonly (ScenarioViewStep & { status: "completed" | "failed"; explained: boolean })[];
  /** The step running, if one is. */
  running: ScenarioViewStep | null;
  remaining: readonly ScenarioViewStep[];
  /** The scenario variables holding a captured session, which /__scenario/sign-in takes over. */
  sessions: readonly string[];
  /** Why the last step failed, until another runs. */
  error: string | null;
};

export type ScenarioViewMessage =
  | { type: "state"; state: ScenarioViewState }
  | { type: "command"; id: string; command: ScenarioViewCommand };

export type ScenarioViewAcknowledgement = { ok: true } | { ok: false; error: string };
