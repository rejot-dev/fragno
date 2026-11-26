// Serves Backoffice from a scenario's runtime, loaded through start-scenario-server.ts's Vite server
// so the app and the scenario share one module graph. /__scenario is the scenario view: its steps,
// and the app in a frame that steps can drive.
import express from "express";
import type { ServerBuild } from "react-router";
import type { ViteDevServer } from "vite";

import type { BackofficeRuntimeEnv } from "../../app/backoffice-runtime/backoffice-runtime-env";
import {
  openBackofficeScenario,
  type BackofficeScenarioDefinition,
  type OpenBackofficeScenario,
} from "../../app/fragno/automation/scenario";
import { mountBackofficeHandler } from "../node-server/node-backoffice-handler";
import { createScenarioExplanations, type ScenarioLaterStep } from "./scenario-explanations";
import { createScenarioViews, scenarioViewStep, type ScenarioViewSteps } from "./scenario-view";
import type { ScenarioViewAcknowledgement, ScenarioViewState } from "./scenario-view-protocol";

// How often work the browser starts, such as a workflow run, moves on; scenarios drain after steps.
const PUMP_INTERVAL_MS = 500;

/**
 * What a scenario module's default export takes: the server's origin, the view's steps, and
 * `later`, for steps built from what earlier steps captured, which the view explains as the step
 * they build.
 */
export type ScenarioModuleInput = {
  origin: string;
  view: ScenarioViewSteps;
  later: ScenarioLaterStep;
};

export async function serveScenario(input: {
  vite: ViteDevServer;
  scenario: (input: ScenarioModuleInput) => BackofficeScenarioDefinition;
  origin: URL;
}): Promise<{ close(): Promise<void> }> {
  const views = createScenarioViews();

  /** The scenario from its start, with Backoffice served from its runtime. */
  async function start(): Promise<{
    scenario: OpenBackofficeScenario;
    app: express.Express;
    explanations: ReturnType<typeof createScenarioExplanations>;
    pump: Pump;
  }> {
    const explanations = createScenarioExplanations();
    const definition = input.scenario({
      origin: input.origin.origin,
      view: views.steps,
      later: explanations.later,
    });
    if (definition.options?.sqliteDataDirectory) {
      // Resetting starts the scenario over, which rows a fixed directory kept would not.
      throw new Error("Served scenarios keep their database in memory; drop sqliteDataDirectory.");
    }
    const scenario = await openBackofficeScenario(
      explanations.explain({
        ...definition,
        env: { ...UNCONFIGURED_SERVICES, ...definition.env },
      }),
    );
    const app = express();
    mountBackofficeHandler(app, {
      runtime: scenario.ctx.runtime,
      build: () =>
        input.vite.ssrLoadModule("virtual:react-router/server-build") as Promise<ServerBuild>,
      mode: "development",
    });
    // A scenario that drains only where it says lets nothing move on between its steps.
    const pump: Pump = definition.options?.drain === false ? { kind: "off" } : { kind: "on" };
    return { scenario, app, explanations, pump };
  }
  let current = await start();
  // Counts resets, so views reload the app from the new runtime.
  let generation = 0;

  // Steps and the pump each drain the runtime, which must not run twice at once.
  let queue = Promise.resolve();
  function exclusively<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  let pumping = false;
  const pump = setInterval(() => {
    const pumped = current;
    if (pumping || pumped.pump.kind !== "on") {
      return;
    }
    pumping = true;
    exclusively(() => pumped.scenario.ctx.runtime.drain())
      .catch((cause: unknown) => {
        console.error("Draining the scenario's runtime failed", cause);
        // Draining again would fail again; the runtime stays as it failed until a reset.
        pumped.pump = { kind: "failed", error: describeError(cause) };
        views.publish(state());
      })
      .finally(() => {
        pumping = false;
      });
  }, PUMP_INTERVAL_MS);

  let error: string | null = null;
  function state(): ScenarioViewState {
    const { scenario } = current;
    const { ctx } = scenario;
    return {
      generation,
      name: ctx.name,
      ran: ctx.journal.entries.map((entry, index) => ({
        ...scenarioViewStep(entry),
        phase: entry.phase,
        status: entry.status,
        explained: current.explanations.explanation(index) !== null,
      })),
      running: ctx.journal.current ? scenarioViewStep(ctx.journal.current) : null,
      remaining: scenario.remaining().map(scenarioViewStep),
      sessions: Object.keys(ctx.vars).filter((variable) => capturedSession(variable) !== null),
      error:
        error ??
        (current.pump.kind === "failed"
          ? `The runtime failed to drain, so nothing moves on by itself; reset to start over. ${current.pump.error}`
          : null),
    };
  }
  views.publish(state());

  /** The session cookies a step captured as `variable`, if it captured any. */
  function capturedSession(variable: string): string | null {
    const value = current.scenario.ctx.vars[variable];
    return typeof value === "string" && value.includes("session_token=") ? value : null;
  }

  const app = express();
  app.disable("x-powered-by");
  // Loopback is reachable from any page the browser shows, by a name it rebinds to loopback too.
  app.use((request, response, next) => {
    if (request.headers.host !== input.origin.host) {
      response.status(421).type("text").send(`The scenario is served at ${input.origin.origin}.`);
      return;
    }
    next();
  });
  app.use("/__scenario", (request, response, next) => {
    const origin = request.headers.origin;
    if (request.method !== "GET" && origin !== undefined && origin !== input.origin.origin) {
      response.status(403).type("text").send("The scenario takes commands from its view only.");
      return;
    }
    next();
  });
  app.get("/__scenario", (_request, response) => {
    response.type("html").send(VIEW_PAGE);
  });
  app.get("/__scenario/state", (_request, response) => {
    response.json(state());
  });
  app.get("/__scenario/ran/:index", (request, response) => {
    const explanation = current.explanations.explanation(Number(request.params.index));
    if (explanation === null) {
      response.status(404).end();
      return;
    }
    response.json(explanation);
  });
  app.get("/__scenario/events", (request, response) => {
    const viewId = request.query.view;
    views.open(typeof viewId === "string" ? viewId : crypto.randomUUID(), response);
  });
  app.post("/__scenario/next", express.json(), (request, response) => {
    // The view whose button asked, which carries out the step's commands; none from curl.
    const body: unknown = request.body;
    const viewId =
      typeof body === "object" && body !== null && "view" in body && typeof body.view === "string"
        ? body.view
        : null;
    void exclusively(async () => {
      error = null;
      views.drivenBy(viewId);
      // `runNext` marks the step running before its first await, which the views show.
      const running = current.scenario.runNext();
      views.publish(state());
      try {
        await running;
      } catch (cause) {
        console.error(cause);
        error = describeError(cause);
      } finally {
        views.publish(state());
      }
    }).then(() => {
      response.status(error === null ? 200 : 500).json(state());
    });
  });
  // Starts the scenario over, from a new runtime, and drops the one it replaces.
  app.post("/__scenario/reset", (_request, response) => {
    void exclusively(async () => {
      const previous = current;
      try {
        current = await start();
        generation += 1;
        error = null;
      } catch (cause) {
        console.error(cause);
        error = describeError(cause);
        return;
      } finally {
        views.publish(state());
      }
      await previous.scenario.ctx.cleanup();
    }).then(() => {
      response.status(error === null ? 200 : 500).json(state());
    });
  });
  app.post("/__scenario/view/:id", express.json(), (request, response) => {
    views.acknowledge(request.params.id, request.body as ScenarioViewAcknowledgement);
    response.status(204).end();
  });
  // Takes over a session a step captured, by the scenario variable it captured it as, then opens
  // `to`, or Backoffice.
  app.get("/__scenario/sign-in/:variable", (request, response) => {
    const cookie = capturedSession(request.params.variable);
    if (cookie === null) {
      response
        .status(404)
        .type("text")
        .send(`No session is captured as ${request.params.variable}.`);
      return;
    }
    for (const pair of cookie.split("; ")) {
      const separator = pair.indexOf("=");
      response.cookie(pair.slice(0, separator), pair.slice(separator + 1), {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        // The value is already signed and encoded as Better Auth issued it.
        encode: (value) => value,
      });
    }
    response.redirect(urlOnOrigin(request.query.to, input.origin) ?? "/backoffice");
  });
  app.use(input.vite.middlewares);
  app.use((request, response, next) => {
    current.app(request, response, next);
  });

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listening = app.listen(Number(input.origin.port), input.origin.hostname, (cause) => {
      if (cause) {
        reject(cause);
      } else {
        resolve(listening);
      }
    });
  });
  return {
    async close() {
      clearInterval(pump);
      // Event streams stay open until their views close, which `server.close` would wait for.
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await exclusively(() => current.scenario.ctx.cleanup());
    },
  };
}

/**
 * The test runtime's placeholder credentials for services no fake stands in for. With them, the
 * app offers those services, such as signing in with GitHub, and fails once someone uses them;
 * without them, it shows them unconfigured, as a deployment without them does. A scenario that
 * fakes one sets its credentials in its `env`.
 */
const UNCONFIGURED_SERVICES = {
  GITHUB_CLIENT_ID: undefined,
  GITHUB_CLIENT_SECRET: undefined,
  GITHUB_APP_ID: undefined,
  GITHUB_APP_SLUG: undefined,
  GITHUB_APP_CLIENT_ID: undefined,
  GITHUB_APP_CLIENT_SECRET: undefined,
  GITHUB_APP_WEBHOOK_SECRET: undefined,
  GITHUB_APP_PRIVATE_KEY: undefined,
  CLOUDFLARE_WORKERS_ACCOUNT_ID: undefined,
  CLOUDFLARE_WORKERS_API_TOKEN: undefined,
  OPENAI_API_KEY: undefined,
} satisfies Partial<BackofficeRuntimeEnv>;

type Pump = { kind: "on" } | { kind: "off" } | { kind: "failed"; error: string };

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * `to` as a URL on `origin`, if it resolves there, so a link cannot send a session anywhere
 * else. Resolving it as browsers do catches forms such as `/\host`, which they read as `//host`.
 * The URL stays absolute: a path such as `//host/x` on `origin` would, as a location, leave it.
 */
function urlOnOrigin(to: unknown, origin: URL): string | null {
  if (typeof to !== "string") {
    return null;
  }
  const url = URL.parse(to, origin);
  return url?.origin === origin.origin ? url.href : null;
}

// The frame shows the app at the same origin, so the view can reach into its page.
const VIEW_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Scenario</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: grid; grid-template-columns: 28rem 1fr;
    font: 14px/1.4 system-ui, sans-serif; color: #1f1d1a; background: #f6f4ef; }
  aside { display: flex; flex-direction: column; gap: 0.75rem; padding: 1rem;
    border-right: 1px solid #e2ddd3; overflow: auto; }
  h1 { font-size: 1rem; margin: 0; }
  .controls { display: flex; gap: 0.5rem; }
  button { font: inherit; padding: 0.35rem 0.75rem; border: 1px solid #cfc8ba; border-radius: 6px;
    background: #fff; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li { padding: 0.3rem 0.5rem; border-radius: 6px; color: #8a8478; }
  li::before { display: inline-block; width: 1.25rem; content: "○"; }
  li.completed { color: #1f1d1a; } li.completed::before { content: "✓"; color: #2f7d4f; }
  li.failed { color: #b42318; } li.failed::before { content: "✗"; }
  li.running { background: #fde8d7; color: #1f1d1a; } li.running::before { content: "▶"; color: #d9622b; }
  li.upcoming:first-of-type { color: #1f1d1a; }
  /* Operations change the scenario's state; view steps only drive the page, beneath them. */
  li.operation { font-weight: 500; }
  li.view { margin-left: 1.25rem; padding-top: 0.15rem; padding-bottom: 0.15rem; font-size: 12.5px;
    font-style: italic; border-left: 2px solid #e2ddd3; border-radius: 0 6px 6px 0; }
  li.view.completed { color: #5c574e; }
  li .tag { margin-left: 0.4rem; padding: 0 0.35rem; border-radius: 4px; font-size: 10px;
    font-style: normal; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    vertical-align: 1px; }
  li.view .tag { background: #e8e4f6; color: #5a4fa0; }
  li.explained { cursor: pointer; }
  li.explained:hover { background: #efebe3; }
  .explanation { margin: 0.4rem 0 0.2rem 1.25rem; padding: 0.5rem; border-radius: 6px;
    background: #fff; border: 1px solid #e2ddd3; font-weight: 400; font-style: normal;
    font-size: 12px; color: #1f1d1a; cursor: default; }
  .explanation p { margin: 0 0 0.35rem; }
  .explanation .changes-heading { color: #8a8478; }
  .explanation code { padding: 0 0.3rem; border-radius: 4px; background: #f1eee8; }
  .change summary { display: flex; gap: 0.4rem; cursor: pointer; list-style: none;
    font-family: ui-monospace, monospace; font-size: 11.5px; }
  .change .op { flex: none; width: 0.8rem; font-weight: 700; }
  .change .table { flex: none; }
  .change.create .op { color: #2f7d4f; } .change.update .op { color: #b4741f; }
  .change.delete .op, .change.truncate .op { color: #b42318; }
  .change .id { color: #8a8478; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .change pre { margin: 0.25rem 0 0.4rem 1.2rem; max-height: 16rem; overflow: auto;
    font-size: 11px; background: #f6f4ef; padding: 0.4rem; border-radius: 4px; }
  .legend { display: flex; flex-direction: column; gap: 0.15rem; font-size: 12px; color: #8a8478; }
  .legend .tag { padding: 0 0.35rem; border-radius: 4px; font-size: 10px; font-weight: 600;
    letter-spacing: 0.04em; text-transform: uppercase; background: #e8e4f6; color: #5a4fa0; }
  .toggle { display: flex; align-items: center; gap: 0.4rem; color: #5c574e; }
  .error { white-space: pre-wrap; color: #b42318; font-size: 12px; }
  .sessions a { color: #b4541f; }
  main { display: grid; grid-template-rows: 1fr auto; min-height: 0; }
  .stage { position: relative; overflow: hidden; }
  iframe { width: 100%; height: 100%; border: 0; background: #fff; }
  #overlay { position: absolute; inset: 0; pointer-events: none; }
  /* Covers the page while the view moves it elsewhere, saying where it goes and why. */
  #curtain { position: absolute; inset: 0; display: grid; place-items: center; padding: 2rem;
    background: rgb(246 244 239 / 0.94); opacity: 0; pointer-events: none;
    transition: opacity 250ms ease-out; }
  #curtain.shown { opacity: 1; pointer-events: auto; }
  #curtain p { max-width: 32rem; margin: 0; text-align: center; font-size: 1.35rem; line-height: 1.35;
    font-weight: 500; text-wrap: balance; }
  /* What is happening now, in one place below the page. */
  .bar { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 1.25rem;
    padding: 0.75rem 1rem; background: #1f1d1a; color: #f6f4ef; }
  .viewer { display: flex; align-items: center; gap: 0.5rem; padding-right: 1.25rem;
    border-right: 1px solid #3d3a35; font-size: 12px; color: #b9b2a5; white-space: nowrap; }
  .viewer .avatar { display: grid; place-items: center; width: 1.9rem; height: 1.9rem;
    border-radius: 50%; background: #d9622b; color: #fff; font-weight: 600; font-size: 13px; }
  .viewer.signed-out .avatar { background: #3d3a35; }
  .viewer b { display: block; color: #f6f4ef; font-size: 13px; font-weight: 500; }
  .now { min-width: 0; }
  .kicker { display: flex; align-items: center; gap: 0.4rem; font-size: 11px; font-weight: 600;
    letter-spacing: 0.05em; text-transform: uppercase; color: #b9b2a5; }
  .kicker.operation { color: #f0a46e; } .kicker.view { color: #b7aef0; }
  .kicker.failed { color: #f19a92; }
  .kicker .pulse { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: currentColor;
    animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.25; } }
  .line { margin-top: 0.15rem; font-size: 15px; line-height: 1.35; }
  .detail { margin-top: 0.15rem; font-size: 12px; color: #b9b2a5; }
  .detail a { color: #f0a46e; cursor: pointer; }
  .bar .controls { align-items: center; }
  .bar .controls button { border-color: #3d3a35; background: #2b2824; color: #f6f4ef; }
  .bar #speed { min-width: 3.25rem; font-variant-numeric: tabular-nums; }
  .bar .controls button.primary { border-color: #d9622b; background: #d9622b; color: #fff; }
  .ring { position: absolute; border: 3px solid #d9622b; border-radius: 8px;
    box-shadow: 0 0 0 9999px rgb(31 29 26 / 0.25); transition: all 150ms ease-out; }
  .caption { position: absolute; max-width: 22rem; padding: 0.5rem 0.75rem; border-radius: 8px;
    background: #1f1d1a; color: #fff; box-shadow: 0 4px 16px rgb(0 0 0 / 0.2); }
</style>
</head>
<body>
<aside>
  <h1 id="name"></h1>
  <div class="controls">
    <button id="reset">Reset</button>
  </div>
  <label class="toggle"><input type="checkbox" id="annotations" checked> Annotations</label>
  <div class="sessions" id="sessions"></div>
  <div class="legend"><span><b>Bold</b>: operations in the scenario</span><span><span class="tag">view</span> drives the page</span></div>
  <ol id="steps"></ol>
  <div class="error" id="error"></div>
</aside>
<main>
  <div class="stage">
    <iframe id="app" name="app" src="/backoffice" title="Backoffice"></iframe>
    <div id="overlay"></div>
    <div id="curtain"><p id="curtain-text"></p></div>
  </div>
  <footer class="bar">
    <div class="viewer signed-out" id="viewer"></div>
    <div class="now">
      <div class="kicker" id="kicker"></div>
      <div class="line" id="line"></div>
      <div class="detail" id="detail"></div>
    </div>
    <div class="controls">
      <button id="speed" title="Playback speed">1×</button>
      <button id="play">Play</button>
      <button id="next" class="primary">Next</button>
    </div>
  </footer>
</main>
<script type="module" src="/scripts/scenario-server/control-view.ts"></script>
</body>
</html>`;
