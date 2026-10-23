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
import { Directory } from "../workers/directory/directory";
import { env as workerEnv } from "./cloudflare-workers";
import { FakeBackoffice } from "./fake-backoffice";
import { FakeDurableObjectNamespace } from "./fake-durable-objects";

const BOOKKEEPING_ORIGIN = "https://bookkeeping.test";
const BACKOFFICE_ORIGIN = "https://backoffice.test";
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
      BOOKKEEPING_OPERATOR_ORGANIZATION_ID: "",
    };
    const env = { ...vars } as unknown as CloudflareEnv;
    const bindings = {
      AUTH: new FakeDurableObjectNamespace(Auth, env),
      DIRECTORY: new FakeDurableObjectNamespace(Directory, env),
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
   * Backoffice's administrator creates the operator organization, owned by these people, as
   * `backoffice:connect` does, and Bookkeeping is configured with it.
   */
  setOperators(...emails: string[]): void {
    const id = this.backoffice.admin.createOrganization("Bookkeeping operators", emails);
    // Pages read `cloudflare:workers`, which holds a copy of the vars, and objects read `env`.
    this.env.BOOKKEEPING_OPERATOR_ORGANIZATION_ID = id;
    workerEnv.BOOKKEEPING_OPERATOR_ORGANIZATION_ID = id;
  }

  /** A new person signs in and gives their name, as the pages lead them. */
  async signUp(email: string, name: string): Promise<ScenarioBrowser> {
    const browser = this.browser();
    const named = await browser.signIn(email);
    if (!named.path.startsWith("/name")) {
      throw new Error(`${email} was not asked for a name: ${JSON.stringify(named)}`);
    }
    await browser.submit(named.path, { name });
    return browser;
  }

  /** An operator creates a firm and invites `ownerEmail` to own it. Returns the firm's path. */
  async createFirm(operator: ScenarioBrowser, name: string, ownerEmail: string): Promise<string> {
    const form = await operator.navigate("/operator/firms/new");
    const { externalId } = form.loaderData["operator/new-firm"] as { externalId: string };
    const created = await operator.submit("/operator/firms/new", { externalId, name, ownerEmail });
    const result = created.actionData as { status: string; path: string };
    if (result.status !== "created") {
      throw new Error(`${name} was not created: ${JSON.stringify(created)}`);
    }
    return result.path;
  }

  /** The path of the latest invitation Backoffice emailed to `email`. */
  invitationPath(email: string): string {
    const sent = this.backoffice.sentInvitations.filter(({ to }) => to === email).at(-1);
    if (!sent) {
      throw new Error(`Backoffice emailed ${email} no invitation.`);
    }
    return new URL(sent.url).pathname;
  }

  /**
   * `email` opens the invitation Backoffice emailed them, or the one at `path`, signs in with that
   * address, giving `name` the first time, and accepts. Returns their browser and the page
   * accepting opened.
   */
  async acceptInvitation(
    email: string,
    name: string,
    { browser = this.browser(), path = this.invitationPath(email) } = {},
  ): Promise<{ browser: ScenarioBrowser; page: ScenarioPage }> {
    let page = await browser.signIn(email, path);
    if (page.path.startsWith("/name")) {
      page = await browser.submit(page.path, { name });
    }
    if (page.path !== path) {
      throw new Error(`Signing in did not return to the invitation: ${JSON.stringify(page)}`);
    }
    return { browser, page: await browser.submit(path, {}) };
  }

  /**
   * `inviter` invites `email` from the members page of the firm or client at `path`. Returns the
   * invitation's path.
   */
  async invite(
    inviter: ScenarioBrowser,
    path: string,
    email: string,
    role: "owner" | "admin" | "member",
  ): Promise<string> {
    const invited = await inviter.submit(`${path}/members`, { email, role });
    const result = invited.actionData as { status: string; link: string };
    if (result.status !== "invited") {
      throw new Error(`${email} was not invited: ${JSON.stringify(invited)}`);
    }
    return new URL(result.link).pathname;
  }

  /** A firm member creates a client, whose workspace opens on its members page. */
  async createClient(
    member: ScenarioBrowser,
    firmPath: string,
    name: string,
  ): Promise<ScenarioPage> {
    const path = `${firmPath}/clients/new`;
    const form = await member.navigate(path);
    const { externalId } = form.loaderData["firms/new-client"] as { externalId: string };
    return await member.submit(path, { externalId, name });
  }

  /**
   * A practice: Grace operates Bookkeeping and creates the firm Lovelace & Co, inviting Ada to own
   * it. Ada accepts and creates the client Analytical Engines. Returns their browsers, signed in.
   */
  async practice(): Promise<{
    grace: ScenarioBrowser;
    ada: ScenarioBrowser;
    firmPath: string;
    clientPath: string;
  }> {
    const grace = await this.signUp("grace@bookkeeping.test", "Grace Hopper");
    this.setOperators("grace@bookkeeping.test");
    const firmPath = await this.createFirm(grace, "Lovelace & Co", "ada@example.test");
    const { browser: ada } = await this.acceptInvitation("ada@example.test", "Ada Lovelace");
    const client = await this.createClient(ada, firmPath, "Analytical Engines");
    const clientPath = /^(\/w\/[^/]+)\/members$/u.exec(client.path)?.[1];
    if (client.status !== 200 || clientPath === undefined) {
      throw new Error(`Analytical Engines did not open: ${JSON.stringify(client)}`);
    }
    return { grace, ada, firmPath, clientPath };
  }

  /** Moves every clock forward: sessions, tokens, and confirmations. */
  advanceTime(ms: number): void {
    vi.setSystemTime(Date.now() + ms);
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
