import { vi } from "vitest";

import type { RouteConfigEntry } from "@react-router/dev/routes";
import {
  createStaticHandler,
  RouterContextProvider,
  type RouteObject,
  type StaticHandler,
} from "react-router";

import routeConfig from "../app/routes";
import { Auth } from "../workers/auth/auth";
import { Books } from "../workers/books/books";
import { Workflows } from "../workers/workflows/workflows";
import { Workspaces } from "../workers/workspaces/workspaces";
import { env as workerEnv } from "./cloudflare-workers";
import { FakeBackoffice } from "./fake-backoffice";
import { FakeDurableObjectNamespace } from "./fake-durable-objects";

const BOOKKEEPING_ORIGIN = "https://bookkeeping.test";
const BACKOFFICE_ORIGIN = "https://backoffice.test";
// Each drain step fires due alarms; work that keeps rescheduling itself is a bug.
const MAX_DRAIN_ROUNDS = 100;
const MAX_REDIRECTS = 10;

type RouteModule = { loader?: RouteObject["loader"]; action?: RouteObject["action"] };

const routeModules = import.meta.glob<RouteModule>("../app/**/*.tsx", { eager: true });

/** Route IDs are the route's file without its extension, as React Router names them. */
function toRouteObjects(entries: RouteConfigEntry[]): RouteObject[] {
  return entries.map((entry) => {
    const module = routeModules[`../app/${entry.file}`];
    if (!module) {
      throw new Error(`Route module app/${entry.file} was not found.`);
    }
    const route = {
      id: entry.id ?? entry.file.replace(/\.tsx?$/u, ""),
      path: entry.path,
      loader: module.loader,
      action: module.action,
    };
    return entry.index
      ? { ...route, index: true }
      : { ...route, children: toRouteObjects(entry.children ?? []) };
  });
}

/** Bookkeeping's routes under its root, served as React Router's server serves them. */
const routes: StaticHandler = createStaticHandler([
  { id: "root", path: "", children: toRouteObjects(routeConfig) },
]);

/** A page as the browser received it, after following redirects. */
export type ScenarioPage = {
  path: string;
  status: number;
  /** Each matched route's loader data, by route ID, e.g. `welcome/welcome`. */
  loaderData: Record<string, unknown>;
  /** The submitted route's action data, when the action answered without redirecting. */
  actionData: unknown;
  /** What a route threw, e.g. a 404 response's text. */
  error: string | null;
};

/**
 * One person's browser: cookies, Better Auth through the Auth object, and Bookkeeping's pages
 * through React Router, following redirects.
 */
export class ScenarioBrowser {
  readonly #scenario: BookkeepingScenario;
  readonly #cookies = new Map<string, string>();

  constructor(scenario: BookkeepingScenario) {
    this.#scenario = scenario;
  }

  get cookie(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /**
   * Starts signing in where `returnTo` will continue, completes Backoffice's sign-in page as
   * `email`, which creates the Backoffice account the first time, and opens where Bookkeeping
   * sends them.
   */
  async signIn(email: string, returnTo = "/start"): Promise<ScenarioPage> {
    const started = await this.auth("/api/auth/sign-in/social", {
      method: "POST",
      body: { provider: "backoffice", callbackURL: returnTo, errorCallbackURL: "/login" },
    });
    const { url } = (await started.json()) as { url: string };
    const callback = new URL(this.#scenario.backoffice.completeSignIn(url, email));
    const returned = await this.auth(callback.pathname + callback.search);
    if (returned.status !== 302) {
      throw new Error(`Signing in failed: HTTP ${returned.status} ${await returned.text()}`);
    }
    return await this.navigate(returned.headers.get("location")!);
  }

  /** A request to Better Auth's endpoints, as the browser's auth client sends it. */
  async auth(
    path: string,
    init: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<Response> {
    const request = new Request(new URL(path, BOOKKEEPING_ORIGIN), {
      method: init.method ?? "GET",
      headers: {
        cookie: this.cookie,
        origin: BOOKKEEPING_ORIGIN,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    });
    const response = await this.#scenario.env.AUTH.getByName("auth").fetch(request);
    this.#keepCookies(response);
    return response;
  }

  async navigate(path: string): Promise<ScenarioPage> {
    return await this.#request(
      new Request(new URL(path, BOOKKEEPING_ORIGIN), { headers: { cookie: this.cookie } }),
    );
  }

  /** Submits a form on the page at `path`, as React Router's `<Form method="post">` does. */
  async submit(path: string, form: Record<string, string>): Promise<ScenarioPage> {
    return await this.#request(
      new Request(new URL(path, BOOKKEEPING_ORIGIN), {
        method: "POST",
        headers: { cookie: this.cookie, origin: BOOKKEEPING_ORIGIN },
        body: new URLSearchParams(form),
      }),
    );
  }

  async #request(request: Request): Promise<ScenarioPage> {
    let current = request;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const result = await routes.query(current, { requestContext: new RouterContextProvider() });
      if (result instanceof Response) {
        this.#keepCookies(result);
        const location = result.headers.get("location");
        if (location === null) {
          throw new Error(`${current.url} answered HTTP ${result.status} without a page.`);
        }
        current = new Request(new URL(location, BOOKKEEPING_ORIGIN), {
          headers: { cookie: this.cookie },
        });
        continue;
      }
      const url = new URL(current.url);
      const [error] = Object.values(result.errors ?? {});
      return {
        path: url.pathname + url.search,
        status: result.statusCode,
        loaderData: result.loaderData,
        actionData: result.actionData === null ? undefined : Object.values(result.actionData)[0],
        error:
          error === undefined
            ? null
            : typeof error === "object" && error !== null && "data" in error
              ? String(error.data)
              : String(error),
      };
    }
    throw new Error(`${request.url} redirected more than ${MAX_REDIRECTS} times.`);
  }

  #keepCookies(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/iu.test(attribute));
      if (expired || value === "") {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, value);
      }
    }
  }
}

/** Bookkeeping's bindings and Backoffice, all in this process. */
export class BookkeepingScenario {
  readonly backoffice = new FakeBackoffice({
    origin: BACKOFFICE_ORIGIN,
    bookkeepingOrigin: BOOKKEEPING_ORIGIN,
  });
  readonly env: CloudflareEnv;
  readonly #namespaces: FakeDurableObjectNamespace<object, CloudflareEnv>[];

  constructor() {
    const vars = {
      BETTER_AUTH_SECRET: "scenario-secret-at-least-thirty-two-characters",
      BOOKKEEPING_BASE_URL: BOOKKEEPING_ORIGIN,
      BACKOFFICE_BASE_URL: BACKOFFICE_ORIGIN,
      BACKOFFICE_OAUTH_CLIENT_ID: this.backoffice.client.id,
      BACKOFFICE_OAUTH_CLIENT_SECRET: this.backoffice.client.secret,
    };
    const env = { ...vars } as unknown as CloudflareEnv;
    const bindings = {
      AUTH: new FakeDurableObjectNamespace(Auth, env),
      WORKSPACES: new FakeDurableObjectNamespace(Workspaces, env),
      WORKFLOWS: new FakeDurableObjectNamespace(Workflows, env),
      BOOKS: new FakeDurableObjectNamespace(Books, env),
    };
    this.#namespaces = Object.values(bindings);
    // The fakes serve the same calls as Cloudflare's namespaces; their types differ.
    this.env = Object.assign(
      env,
      bindings as unknown as Pick<CloudflareEnv, keyof typeof bindings>,
    );
  }

  browser(): ScenarioBrowser {
    return new ScenarioBrowser(this);
  }

  /**
   * A new person signs in, gives their name, answers the wizard, and ends up in their new
   * workspace, as the pages lead them. Returns their browser, signed in.
   */
  async signUp(person: {
    email: string;
    name: string;
    businessName: string;
  }): Promise<ScenarioBrowser> {
    const browser = this.browser();
    const named = await browser.signIn(person.email);
    await browser.submit(named.path, { name: person.name });
    await this.drain();
    await browser.submit("/welcome", { businessName: person.businessName });
    await this.drain();
    const workspace = await browser.navigate("/welcome");
    if (!workspace.path.startsWith("/w/")) {
      throw new Error(`${person.email} did not reach a workspace: ${JSON.stringify(workspace)}`);
    }
    return browser;
  }

  /** Moves every clock forward: sessions, tokens, confirmations, and workflow retries. */
  advanceTime(ms: number): void {
    vi.setSystemTime(Date.now() + ms);
  }

  /** Fires due alarms and waits for background work until nothing is left. */
  async drain(): Promise<void> {
    for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
      let fired = false;
      for (const namespace of this.#namespaces) {
        for (const { state, object } of namespace.entries()) {
          await state.ready;
          await state.settle();
          if (state.dueAlarm(Date.now()) !== null && "alarm" in object) {
            state.clearAlarm();
            await (object as { alarm(): Promise<void> }).alarm();
            fired = true;
          }
        }
      }
      if (!fired) {
        return;
      }
    }
    throw new Error(`Durable Object alarms kept firing after ${MAX_DRAIN_ROUNDS} rounds.`);
  }

  /** Requests leaving Bookkeeping: Backoffice's origin reaches the fake, anything else fails. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (new URL(request.url).origin === BACKOFFICE_ORIGIN) {
      return await this.backoffice.fetch(request);
    }
    throw new Error(`Scenario blocked a request to ${request.url}.`);
  };

  close(): void {
    for (const namespace of this.#namespaces) {
      namespace.close();
    }
  }
}

/**
 * Runs `steps` against a fresh Bookkeeping and Backoffice. Bookkeeping's code reads the bindings
 * from `cloudflare:workers`, calls Backoffice with the global `fetch`, and reads the time from
 * `Date`, so all three belong to this scenario until it ends.
 */
export async function runBookkeepingScenario(
  steps: (scenario: BookkeepingScenario) => Promise<void>,
): Promise<void> {
  const scenario = new BookkeepingScenario();
  const originalFetch = globalThis.fetch;
  Object.assign(workerEnv, scenario.env);
  globalThis.fetch = scenario.fetch;
  // Only the date is faked; it stands still unless the scenario advances it. Timers stay real.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  try {
    await steps(scenario);
  } finally {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(workerEnv)) {
      delete workerEnv[key];
    }
    scenario.close();
  }
}
