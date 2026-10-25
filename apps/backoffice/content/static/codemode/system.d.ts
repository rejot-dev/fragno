// Codemode globals. Each reference says when to read its declarations.
// Workflow authoring: defineWorkflow, steps, sleeps, and waits. Read before defining a workflow.
/// <reference path="/static/codemode/workflow-authoring.d.ts" />
// Interface builder for generated UIs. Read before returning a ui.
/// <reference path="/static/codemode/ui.d.ts" />
// Page builder: live queries bound to a ui. Read before writing a .page.js page.
/// <reference path="/static/codemode/page.d.ts" />
// Files in /workspace and /static, and links that share them. Read for file work beyond searching, reading, and writing, or to share or move files.
/// <reference path="/static/codemode/providers/state.d.ts" />
// Your own account: profile, organizations, invitations, authorized apps. Read when the user asks about themselves.
/// <reference path="/static/codemode/providers/account.d.ts" />
// System administration: organizations, sign-ups, app registrations, OAuth clients, Marketplace features. Read in System scope.
/// <reference path="/static/codemode/providers/admin.d.ts" />
// Current organization: name, members, invitations. Read to rename it, list members, or invite someone.
/// <reference path="/static/codemode/providers/org.d.ts" />
// Installed apps: review, install, grants, action approval, uninstall. Read to install or manage an app.
/// <reference path="/static/codemode/providers/apps.d.ts" />
// Backoffice capabilities and whether each is configured. Read to check that a service is set up.
/// <reference path="/static/codemode/providers/capabilities.d.ts" />
// Durable hook queues. Read to debug stuck or retrying background delivery.
/// <reference path="/static/codemode/providers/hooks.d.ts" />
// External service connections: set up, inspect, run actions, generate typed clients. Read for any third-party service.
/// <reference path="/static/codemode/providers/integrations.d.ts" />
// Scope-owned key/value store. Read to keep small values across runs.
/// <reference path="/static/codemode/providers/store.d.ts" />
// External identities bound to users. Read when a workflow acts for an external sender.
/// <reference path="/static/codemode/providers/identity.d.ts" />
// Automation routes: event or schedule triggers that start or signal workflows, forward events, or notify agents. Read to automate anything later or recurring.
/// <reference path="/static/codemode/providers/router.d.ts" />
// Workflow instances: start saved workflows, check status and history, send events, retry steps. Read to run or follow a workflow.
/// <reference path="/static/codemode/providers/workflow.d.ts" />
// Automation events: catalog, stored events and the routes they matched, firing, retries. Read to see what can trigger automations or why one did not act.
/// <reference path="/static/codemode/providers/events.d.ts" />
// Schema-backed forms and their submissions. Read to create a form or read responses.
/// <reference path="/static/codemode/providers/forms.d.ts" />
// Cloudflare Browser Run: screenshots, PDFs, crawls. Read to capture or crawl a page in a real browser.
/// <reference path="/static/codemode/providers/cloudflare.d.ts" />
// URL and HTML extraction to content or Markdown. Read to fetch a web page.
/// <reference path="/static/codemode/providers/web.d.ts" />
// Classifiers for typed questions about data and images, and image generation. Read to classify or generate images.
/// <reference path="/static/codemode/providers/models.d.ts" />
// Identity-claim links for external senders. Read to let an external user link their account.
/// <reference path="/static/codemode/providers/otp.d.ts" />
// Agents: define, prompt, stop, and read conversations. Read to work with an agent, including your own definition.
/// <reference path="/static/codemode/providers/pi.d.ts" />
// Projects in an organization or personal scope. Read to create or list projects.
/// <reference path="/static/codemode/providers/projects.d.ts" />
// Reson8 speech-to-text. Read to transcribe audio.
/// <reference path="/static/codemode/providers/reson8.d.ts" />
// Cloudflare sandboxes with a real shell. Read when work needs command-line tools.
/// <reference path="/static/codemode/providers/sandbox.d.ts" />
// Saved JavaScript: check, run, build modules, and inspect codemode runs. Read to save, run, or debug a script file.
/// <reference path="/static/codemode/providers/js.d.ts" />
// Page builds and their errors. Read to verify a page after writing it.
/// <reference path="/static/codemode/providers/artifacts.d.ts" />
// Marketplace packages: search, inspect, publish, feature. Read to find or publish a package.
/// <reference path="/static/codemode/providers/marketplace.d.ts" />
// Package installs into the workspace. Read to install a Marketplace package or list installed ones.
/// <reference path="/static/codemode/providers/packages.d.ts" />

// Scoped context handles target a selected Backoffice context.
type BackofficeCodemodeRootOwner =
  | { kind: "org"; orgId: string }
  | { kind: "user"; userId: string };
type BackofficeCodemodeAppScope = {
  kind: "app";
  owner: BackofficeCodemodeRootOwner;
  appId: string;
};
type BackofficeCodemodeScope =
  | { kind: "system" }
  | BackofficeCodemodeRootOwner
  | BackofficeCodemodeAppScope
  | {
      kind: "project";
      owner: BackofficeCodemodeRootOwner | BackofficeCodemodeAppScope;
      projectId: string;
    };
interface BackofficeCodemodeScopedProviders {
  state: StateCodemodeProvider;
  account: AccountCodemodeProvider;
  admin: AdminCodemodeProvider;
  org: OrgCodemodeProvider;
  apps: AppsCodemodeProvider;
  capabilities: CapabilitiesCodemodeProvider;
  hooks: HooksCodemodeProvider;
  integrations: IntegrationsCodemodeProvider;
  store: StoreCodemodeProvider;
  identity: IdentityCodemodeProvider;
  router: RouterCodemodeProvider;
  workflow: WorkflowCodemodeProvider;
  events: EventsCodemodeProvider;
  forms: FormsCodemodeProvider;
  cloudflare: CloudflareCodemodeProvider;
  web: WebCodemodeProvider;
  models: ModelsCodemodeProvider;
  otp: OtpCodemodeProvider;
  pi: PiCodemodeProvider;
  projects: ProjectsCodemodeProvider;
  reson8: Reson8CodemodeProvider;
  sandbox: SandboxCodemodeProvider;
  js: JsCodemodeProvider;
  artifacts: ArtifactsCodemodeProvider;
  marketplace: MarketplaceCodemodeProvider;
  packages: PackagesCodemodeProvider;
}
declare const context: {
  /** Return the exact scope governing this codemode execution. */
  getCurrentScope(): Promise<BackofficeCodemodeScope>;
  /** Providers bound to the selected current context. */
  readonly current: BackofficeCodemodeScopedProviders;
  /** Providers bound to an organization context. */
  org(orgId: string): BackofficeCodemodeScopedProviders;
  /** Providers bound to a user context. */
  user(userId: string): BackofficeCodemodeScopedProviders;
  /** Providers bound to a project of the current organization or personal scope. */
  project(projectId: string): BackofficeCodemodeScopedProviders;
};
