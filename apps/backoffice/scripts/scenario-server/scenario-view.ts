import type { Response } from "express";

import type { BackofficeScenarioStep } from "../../app/fragno/automation/scenario";
import type {
  ScenarioViewAcknowledgement,
  ScenarioViewCommand,
  ScenarioViewMessage,
  ScenarioViewState,
  ScenarioViewStep,
  ScenarioViewTarget,
} from "./scenario-view-protocol";

// Long enough for a cold page to load through Vite, which the view waits for before it acknowledges.
const COMMAND_TIMEOUT_MS = 30_000;

/** Steps that drive the app's page in the scenario view, given to scenario modules. */
export type ScenarioViewSteps = {
  navigate(path: string, label?: string): BackofficeScenarioStep;
  highlight(target: ScenarioViewTarget, caption: string): BackofficeScenarioStep;
  click(target: ScenarioViewTarget, label?: string): BackofficeScenarioStep;
};

// The step types of the steps below start with it, which tells them apart from other steps.
const VIEW_STEP_TYPE_PREFIX = "view.";

/** A scenario step as the view lists it. */
export function scenarioViewStep(step: { label: string; type: string }): ScenarioViewStep {
  return {
    label: step.label,
    kind: step.type.startsWith(VIEW_STEP_TYPE_PREFIX) ? "view" : "operation",
  };
}

function describeTarget(target: ScenarioViewTarget): string {
  return "selector" in target ? target.selector : `"${target.text}"`;
}

/** A command a step sent, carried out by one view at a time. */
type PendingCommand = {
  message: Extract<ScenarioViewMessage, { type: "command" }>;
  /** The view carrying it out, or none while no view it has not failed in is open. */
  view: Response | null;
  failedIn: Set<Response>;
  settle(acknowledgement: ScenarioViewAcknowledgement): void;
  /** Fails the command without handing it to another view. */
  abandon(error: string): void;
};

/**
 * The scenario views open in browsers: what the server streams them, and the commands their steps
 * send, which run once a view acknowledges them.
 */
export function createScenarioViews() {
  const views = new Set<Response>();
  const pending = new Map<string, PendingCommand>();
  let state: ScenarioViewState | null = null;

  function send(view: Response, message: ScenarioViewMessage) {
    view.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  /**
   * Hands the command to one view, as a click carried out in two would act twice. The view opened
   * last goes first: it is likeliest the one in front of the reviewer.
   */
  function assign(command: PendingCommand) {
    const view = [...views].reverse().find((candidate) => !command.failedIn.has(candidate));
    command.view = view ?? null;
    if (view) {
      send(view, command.message);
    }
  }

  async function command(command: ScenarioViewCommand, description: string): Promise<void> {
    if (views.size === 0) {
      // Steps run without a view too, such as from curl; there is no page to drive.
      console.warn(`No scenario view is open to ${description}.`);
      return;
    }
    const id = crypto.randomUUID();
    const acknowledgement = await new Promise<ScenarioViewAcknowledgement>((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: `No scenario view managed to ${description} in time.` });
      }, COMMAND_TIMEOUT_MS);
      const sent: PendingCommand = {
        message: { type: "command", id, command },
        view: null,
        failedIn: new Set(),
        settle(result) {
          if (!result.ok && sent.view) {
            // Another view may manage, such as when this one's frame shows another origin's page.
            sent.failedIn.add(sent.view);
            assign(sent);
            if (sent.view) {
              return;
            }
          }
          clearTimeout(timeout);
          pending.delete(id);
          resolve(result);
        },
        abandon(error) {
          clearTimeout(timeout);
          pending.delete(id);
          resolve({ ok: false, error });
        },
      };
      pending.set(id, sent);
      assign(sent);
    });
    if (!acknowledgement.ok) {
      throw new Error(acknowledgement.error);
    }
  }

  function step(
    kind: ScenarioViewCommand["kind"],
    label: string,
    run: () => Promise<void>,
  ): BackofficeScenarioStep {
    // Driving the page changes nothing the runtime would drain.
    return { type: `${VIEW_STEP_TYPE_PREFIX}${kind}`, label, drain: false, run };
  }

  const steps: ScenarioViewSteps = {
    navigate: (path, label = `open ${path}`) =>
      step("navigate", label, () => command({ kind: "navigate", path }, `open ${path}`)),
    highlight: (target, caption) =>
      step("highlight", caption, () =>
        command({ kind: "highlight", target, caption }, `highlight ${describeTarget(target)}`),
      ),
    click: (target, label = `click ${describeTarget(target)}`) =>
      step("click", label, () =>
        command({ kind: "click", target }, `click ${describeTarget(target)}`),
      ),
  };

  return {
    steps,
    open(view: Response) {
      view.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      views.add(view);
      view.on("close", () => {
        views.delete(view);
        // The commands it was carrying out go to another view, or wait for one to open. A click
        // may have happened before the view closed, and another view clicking again would act
        // twice, so its step fails instead.
        for (const command of pending.values()) {
          if (command.view !== view) {
            continue;
          }
          if (command.message.command.kind === "click") {
            command.abandon(
              "The scenario view closed while it clicked, so whether the click happened is unknown; reset to start over.",
            );
          } else {
            assign(command);
          }
        }
      });
      if (state) {
        send(view, { type: "state", state });
      }
      // A view that opens while a command waits for one, such as a reloaded view, takes it over.
      for (const command of pending.values()) {
        if (command.view === null) {
          assign(command);
        }
      }
    },
    publish(next: ScenarioViewState) {
      state = next;
      for (const view of views) {
        send(view, { type: "state", state: next });
      }
    },
    /** A view answers the command it was handed. */
    acknowledge(id: string, acknowledgement: ScenarioViewAcknowledgement) {
      pending.get(id)?.settle(acknowledgement);
    },
  };
}
