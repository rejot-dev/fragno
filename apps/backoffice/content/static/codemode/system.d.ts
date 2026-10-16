/// <reference path="/static/codemode/workflow-authoring.d.ts" />
/// <reference path="/static/codemode/ui.d.ts" />
/// <reference path="/static/codemode/providers/state.d.ts" />
/// <reference path="/static/codemode/providers/account.d.ts" />
/// <reference path="/static/codemode/providers/admin.d.ts" />
/// <reference path="/static/codemode/providers/org.d.ts" />
/// <reference path="/static/codemode/providers/apps.d.ts" />
/// <reference path="/static/codemode/providers/capabilities.d.ts" />
/// <reference path="/static/codemode/providers/hooks.d.ts" />
/// <reference path="/static/codemode/providers/integrations.d.ts" />
/// <reference path="/static/codemode/providers/store.d.ts" />
/// <reference path="/static/codemode/providers/identity.d.ts" />
/// <reference path="/static/codemode/providers/router.d.ts" />
/// <reference path="/static/codemode/providers/workflow.d.ts" />
/// <reference path="/static/codemode/providers/events.d.ts" />
/// <reference path="/static/codemode/providers/forms.d.ts" />
/// <reference path="/static/codemode/providers/cloudflare.d.ts" />
/// <reference path="/static/codemode/providers/web.d.ts" />
/// <reference path="/static/codemode/providers/otp.d.ts" />
/// <reference path="/static/codemode/providers/pi.d.ts" />
/// <reference path="/static/codemode/providers/sandbox.d.ts" />
/// <reference path="/static/codemode/providers/js.d.ts" />
/// <reference path="/static/codemode/providers/upload.d.ts" />
/// <reference path="/static/codemode/providers/marketplace.d.ts" />
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
  otp: OtpCodemodeProvider;
  pi: PiCodemodeProvider;
  sandbox: SandboxCodemodeProvider;
  js: JsCodemodeProvider;
  upload: UploadCodemodeProvider;
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
  /** Project contexts are reserved until the project model exists. */
  project(projectId: string): BackofficeCodemodeScopedProviders;
};
