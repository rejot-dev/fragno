// The scenario view's script, which Vite serves to /__scenario: it shows the scenario's steps, runs
// them, and carries out the commands its steps give the app's page in the frame.
import type {
  ScenarioViewAcknowledgement,
  ScenarioViewCommand,
  ScenarioViewExplanation,
  ScenarioViewMessage,
  ScenarioViewState,
  ScenarioViewStep,
  ScenarioViewTarget,
} from "./scenario-view-protocol";

// Pages render after their data downloads, so targets get a while to show up.
const FIND_TIMEOUT_MS = 15_000;
const PLAY_PAUSE_MS = 1_500;
// Long enough to see what is about to be clicked.
const CLICK_PREVIEW_MS = 600;

type AppWindow = Window & {
  // React Router's own handle on the hydrated app, which navigates without reloading it.
  __reactRouterDataRouter?: {
    navigate(to: string): Promise<void>;
    state: { navigation: { state: string } };
  };
};

function byId<T extends HTMLElement>(id: string, type: abstract new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) {
    throw new Error(`The scenario view has no #${id} that is a ${type.name}.`);
  }
  return found;
}

const frame = byId("app", HTMLIFrameElement);
const overlay = byId("overlay", HTMLElement);
const nextButton = byId("next", HTMLButtonElement);
const playButton = byId("play", HTMLButtonElement);
const resetButton = byId("reset", HTMLButtonElement);
const annotationsToggle = byId("annotations", HTMLInputElement);

// The view's own setting, kept across reloads; the app shares this origin's storage.
const ANNOTATIONS_STORAGE_KEY = "scenario-view.annotations";
// The app's appearance menu keeps its motion choice under this key, and marks the page's root with
// it; see appearance-preferences.ts.
const REDUCED_MOTION_STORAGE_KEY = "reduced-motion";

let state: ScenarioViewState | null = null;
// The playback running, if any; a playback pausing and another starting before the first's
// pending step returns must not both go on.
let playback: symbol | null = null;
// The ran steps whose explanations are open, by their place in the journal.
const expanded = new Set<number>();
const explanations = new Map<number, ScenarioViewExplanation>();
// The changes whose values are open, as `<step index>:<change index>`, which renders keep open.
const openChanges = new Set<string>();
let annotations = localStorage.getItem(ANNOTATIONS_STORAGE_KEY) !== "off";
annotationsToggle.checked = annotations;

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor<T>(description: string, find: () => T | null): Promise<T> {
  const deadline = Date.now() + FIND_TIMEOUT_MS;
  for (;;) {
    const found = find();
    if (found !== null) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`The page did not show ${description}.`);
    }
    await delay(150);
  }
}

function appWindow(): AppWindow {
  const window = frame.contentWindow;
  if (!window) {
    throw new Error("The app's frame has no page.");
  }
  return window;
}

function render(next: ScenarioViewState) {
  if (state && state.generation !== next.generation) {
    // The app's page belongs to the runtime the reset dropped, as does its session.
    playback = null;
    clearHighlight();
    frame.src = "/backoffice";
    expanded.clear();
    explanations.clear();
    openChanges.clear();
  }
  state = next;
  document.title = next.name;
  byId("name", HTMLElement).textContent = next.name;
  const steps = byId("steps", HTMLElement);
  steps.replaceChildren(
    ...next.ran.map((step, index) => {
      const li = item(step, step.status);
      // View steps change nothing; their explanation would only repeat their label.
      if (step.explained && step.kind === "operation") {
        li.classList.add("explained");
        li.addEventListener("click", (event) => {
          // Clicks inside an open explanation, such as on its changes, keep it open.
          if ((event.target as Element).closest(".explanation")) {
            return;
          }
          if (!expanded.delete(index)) {
            expanded.add(index);
          }
          if (state) {
            render(state);
          }
        });
        if (expanded.has(index)) {
          li.appendChild(explanationOf(index));
        }
      }
      return li;
    }),
    ...(next.running ? [item(next.running, "running")] : []),
    // While a step runs, `remaining` no longer lists it.
    ...next.remaining.map((step) => item(step, "upcoming")),
  );
  byId("error", HTMLElement).textContent = next.error ?? "";
  byId("sessions", HTMLElement).replaceChildren(
    ...next.sessions.map((variable) => {
      const link = document.createElement("a");
      link.href = `/__scenario/sign-in/${encodeURIComponent(variable)}`;
      link.target = "app";
      link.textContent = `Open as ${variable}`;
      return link;
    }),
  );
  const idle = next.running === null;
  nextButton.disabled = !idle || next.remaining.length === 0 || playback !== null;
  resetButton.disabled = !idle;
  playButton.disabled = next.remaining.length === 0 && playback === null;
  playButton.textContent = playback === null ? "Play" : "Pause";
}

/** What a ran step did, once loaded; the server keeps it until the scenario is reset. */
function explanationOf(index: number): HTMLElement {
  const container = document.createElement("div");
  container.className = "explanation";
  const known = explanations.get(index);
  if (!known) {
    container.textContent = "Loading…";
    void fetch(`/__scenario/ran/${index}`).then(async (response) => {
      if (!response.ok) {
        // Such as a step of the runtime a reset dropped.
        container.textContent = "This step has no explanation.";
        return;
      }
      explanations.set(index, await response.json<ScenarioViewExplanation>());
      if (state) {
        render(state);
      }
    });
    return container;
  }
  const does = document.createElement("p");
  does.className = "does";
  const type = document.createElement("code");
  type.textContent = known.does.type;
  does.appendChild(type);
  does.appendChild(document.createTextNode(` ${known.does.label}`));
  const heading = document.createElement("p");
  heading.className = "changes-heading";
  heading.textContent =
    // Only the Automations of the scenario's organizations are read; other stores, such as
    // auth's, change unseen.
    known.changes.length === 0
      ? "Changed no Automations rows"
      : `Changed ${known.changes.length} Automations rows`;
  container.appendChild(does);
  container.appendChild(heading);
  for (const [changeIndex, change] of known.changes.entries()) {
    const details = document.createElement("details");
    details.className = `change ${change.op}`;
    const key = `${index}:${changeIndex}`;
    details.open = openChanges.has(key);
    details.addEventListener("toggle", () => {
      if (details.open) {
        openChanges.add(key);
      } else {
        openChanges.delete(key);
      }
    });
    const summary = document.createElement("summary");
    const op = document.createElement("span");
    op.className = "op";
    op.textContent = { create: "+", update: "~", delete: "−", truncate: "∅" }[change.op];
    const table = document.createElement("span");
    table.className = "table";
    table.textContent = change.table;
    const id = document.createElement("span");
    id.className = "id";
    id.textContent = change.id;
    for (const part of [op, table, id]) {
      summary.appendChild(part);
    }
    const values = document.createElement("pre");
    values.textContent = JSON.stringify(change.values, null, 2);
    details.appendChild(summary);
    details.appendChild(values);
    container.appendChild(details);
  }
  return container;
}

function item(step: ScenarioViewStep, status: string) {
  const li = document.createElement("li");
  li.classList.add(status, step.kind);
  li.textContent = step.label;
  if (step.kind === "view") {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "view";
    li.appendChild(tag);
  }
  return li;
}

async function runNext(): Promise<ScenarioViewState> {
  const response = await fetch("/__scenario/next", { method: "POST" });
  // A step that fails answers 500 with the state too, whose `error` says why.
  return await response.json<ScenarioViewState>();
}

async function play() {
  const current = Symbol("playback");
  playback = current;
  let remaining = state?.remaining.length ?? 0;
  while (playback === current && remaining > 0) {
    const after = await runNext();
    if (after.error) {
      break;
    }
    remaining = after.remaining.length;
    if (remaining > 0) {
      await delay(PLAY_PAUSE_MS);
    }
  }
  if (playback === current) {
    playback = null;
  }
  if (state) {
    render(state);
  }
}

/** The innermost element showing the target, once the page shows it. */
function findTarget(target: ScenarioViewTarget): Promise<HTMLElement> {
  const description = "selector" in target ? target.selector : `"${target.text}"`;
  return waitFor(description, () => {
    const document = frame.contentDocument;
    if (!document?.body) {
      return null;
    }
    const shown = (element: Element) => element.getClientRects().length > 0;
    if ("selector" in target) {
      const found = document.querySelector<HTMLElement>(target.selector);
      return found && shown(found) ? found : null;
    }
    const showing = [...document.body.querySelectorAll<HTMLElement>("*")].filter(
      (element) => element.textContent?.includes(target.text) && shown(element),
    );
    return (
      showing.find(
        (element) => !showing.some((other) => other !== element && element.contains(other)),
      ) ?? null
    );
  });
}

let highlighted: HTMLElement | null = null;

function clearHighlight() {
  highlighted = null;
  overlay.replaceChildren();
}

function highlight(element: HTMLElement, caption: string) {
  element.scrollIntoView({ block: "center", inline: "center" });
  if (!annotations) {
    return;
  }
  const ring = document.createElement("div");
  ring.className = "ring";
  const bubble = document.createElement("div");
  bubble.className = "caption";
  bubble.textContent = caption;
  overlay.replaceChildren(ring, ...(caption ? [bubble] : []));
  highlighted = element;
  // The page scrolls and re-renders under the highlight, which follows its element.
  const follow = () => {
    if (highlighted !== element) {
      return;
    }
    if (!element.isConnected) {
      clearHighlight();
      return;
    }
    const rect = element.getBoundingClientRect();
    Object.assign(ring.style, {
      left: `${rect.left - 6}px`,
      top: `${rect.top - 6}px`,
      width: `${rect.width + 12}px`,
      height: `${rect.height + 12}px`,
    });
    const below = rect.bottom + 16 + bubble.offsetHeight < overlay.clientHeight;
    Object.assign(bubble.style, {
      left: `${Math.max(8, Math.min(rect.left, overlay.clientWidth - bubble.offsetWidth - 8))}px`,
      top: below ? `${rect.bottom + 14}px` : `${rect.top - bubble.offsetHeight - 14}px`,
    });
    requestAnimationFrame(follow);
  };
  follow();
}

/** The app's router, while the frame shows the app; another origin's page has none to reach. */
function appRouter(): AppWindow["__reactRouterDataRouter"] | null {
  try {
    return appWindow().__reactRouterDataRouter ?? null;
  } catch {
    // Such as the browser's error page, which a frame shows once the server it loaded from stops.
    return null;
  }
}

async function navigate(path: string) {
  clearHighlight();
  const router = appRouter();
  // Scenario routes, such as signing in, are not the app's, so they load the frame anew.
  if (!router || path.startsWith("/__scenario/")) {
    const loaded = new Promise((resolve) => {
      frame.addEventListener("load", resolve, { once: true });
    });
    frame.src = path;
    await loaded;
    await waitFor("the app", appRouter);
    return;
  }
  await router.navigate(path);
  await waitFor("the page", () => (router.state.navigation.state === "idle" ? true : null));
}

async function perform(command: ScenarioViewCommand) {
  switch (command.kind) {
    case "navigate":
      await navigate(command.path);
      return;
    case "highlight":
      highlight(await findTarget(command.target), command.caption);
      return;
    case "click": {
      const element = await findTarget(command.target);
      highlight(element, "");
      if (annotations) {
        await delay(CLICK_PREVIEW_MS);
      }
      clearHighlight();
      element.click();
      return;
    }
  }
}

async function carryOut(id: string, command: ScenarioViewCommand) {
  let acknowledgement: ScenarioViewAcknowledgement;
  try {
    await perform(command);
    acknowledgement = { ok: true };
  } catch (error) {
    acknowledgement = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  await fetch(`/__scenario/view/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(acknowledgement),
  });
}

nextButton.addEventListener("click", () => {
  void runNext();
});
playButton.addEventListener("click", () => {
  if (playback !== null) {
    playback = null;
  } else {
    void play();
  }
  if (state) {
    render(state);
  }
});
resetButton.addEventListener("click", () => {
  playback = null;
  void fetch("/__scenario/reset", { method: "POST" });
});
annotationsToggle.addEventListener("change", () => {
  annotations = annotationsToggle.checked;
  localStorage.setItem(ANNOTATIONS_STORAGE_KEY, annotations ? "on" : "off");
  if (!annotations) {
    clearHighlight();
  }
});

/**
 * Keeps the app's motion on, whatever the system or the appearance menu asks for: a scenario shows
 * the app as it moves.
 */
function keepMotion() {
  localStorage.setItem(REDUCED_MOTION_STORAGE_KEY, "no-preference");
  const root = frame.contentDocument?.documentElement;
  if (!root) {
    return;
  }
  const allowMotion = () => {
    if (root.dataset.reducedMotion !== "no-preference") {
      root.dataset.reducedMotion = "no-preference";
    }
  };
  allowMotion();
  new MutationObserver(allowMotion).observe(root, {
    attributes: true,
    attributeFilter: ["data-reduced-motion"],
  });
}
keepMotion();
frame.addEventListener("load", () => {
  // Someone clicking around the app moves the page from under a highlight.
  clearHighlight();
  keepMotion();
});

new EventSource("/__scenario/events").addEventListener("message", (event: MessageEvent<string>) => {
  const message = JSON.parse(event.data) as ScenarioViewMessage;
  if (message.type === "state") {
    render(message.state);
  } else {
    void carryOut(message.id, message.command);
  }
});
