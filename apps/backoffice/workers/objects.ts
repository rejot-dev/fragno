import { migratable, migrationRoute } from "@rivet-dev/durable-object-migrator/worker";
import System from "typebox/system";

import { Api as ApiObject } from "./api.do";
import { AppInstallations as AppInstallationsObject } from "./app-installations.do";
import { Apps as AppsObject } from "./apps.do";
import { Auth as AuthObject } from "./auth.do";
import { Automations as AutomationsObject } from "./automations.do";
import { Billing as BillingObject } from "./billing.do";
import { Blobs as BlobsObject } from "./blobs.do";
import { Cloudflare as CloudflareObject } from "./cloudflare.do";
import { Codemode as CodemodeObject } from "./codemode.do";
import { Forms as FormsObject } from "./forms.do";
import { GitHubWebhookRouter as GitHubWebhookRouterObject } from "./github-webhook-router.do";
import { GitHub as GitHubObject } from "./github.do";
import { Marketplace as MarketplaceObject } from "./marketplace.do";
import { Mcp as McpObject } from "./mcp.do";
import { Otp as OtpObject } from "./otp.do";
import { PiManager as PiManagerObject } from "./pi-manager.do";
import { Pi as PiObject } from "./pi.do";
import { Presence as PresenceObject } from "./presence.do";
import { ProjectConnectorDurableObject as ProjectConnectorObject } from "./project-connector.do";
import { Resend as ResendObject } from "./resend.do";
import { SandboxManager as SandboxManagerObject } from "./sandbox-manager.do";
import { Telegram as TelegramObject } from "./telegram.do";
import { Upload as UploadObject } from "./upload.do";

System.Settings.Set({ useAcceleration: false });

// Startup evaluates this module and every `*.do.ts` it imports, whichever object woke the isolate.
// Each object class imports its implementation (`*-object.ts`) on first use, so keep `*.do.ts`
// free of value imports.

// Public HTTP serves only the Durable Object migrator, which copies each object to the Rivet host
// once; every other request is not found.
export default {
  fetch(request, env) {
    return (
      migrationRoute(request, namedObjectsEnv(request, env), {
        token: env.WORKER_MIGRATOR_TOKEN,
      }) ?? new Response("Not Found", { status: 404 })
    );
  },
} satisfies ExportedHandler<CloudflareEnv>;

/**
 * The migrator reaches objects with a plain `idFromName` and `idFromString`, but Backoffice objects
 * read their address from `ctx.id.name`, which an ID string does not carry, and an owner's objects
 * live in its jurisdiction, where the same name is another object. The Rivet host names both;
 * like `jurisdictionNamespace`, local development ignores jurisdictions, which workerd lacks.
 */
function namedObjectsEnv(request: Request, env: CloudflareEnv): CloudflareEnv {
  const query = new URL(request.url).searchParams;
  const name = query.get("name");
  const jurisdiction =
    env.DURABLE_OBJECT_JURISDICTIONS === "local" ? null : query.get("jurisdiction");
  return new Proxy(env, {
    get(target, key) {
      const value = target[key as keyof CloudflareEnv];
      if (!value || typeof value !== "object" || !("idFromName" in value)) {
        return value;
      }
      const namespace = jurisdiction
        ? (value as DurableObjectNamespace).jurisdiction(jurisdiction as DurableObjectJurisdiction)
        : (value as DurableObjectNamespace);
      return {
        idFromName: (objectName: string) => namespace.idFromName(objectName),
        idFromString: (id: string) =>
          name === null ? namespace.idFromString(id) : namespace.idFromName(name),
        get: (id: DurableObjectId) => namespace.get(id),
      };
    },
  });
}

// Once the migrator copies an object, its Cloudflare copy rejects app traffic. The types keep
// `worker-configuration.d.ts` typing each namespace by its object class.
export const Api = migratable(ApiObject);
export type Api = ApiObject;
export const Apps = migratable(AppsObject);
export type Apps = AppsObject;
export const AppInstallations = migratable(AppInstallationsObject);
export type AppInstallations = AppInstallationsObject;
export const Auth = migratable(AuthObject);
export type Auth = AuthObject;
export const Automations = migratable(AutomationsObject);
export type Automations = AutomationsObject;
export const Billing = migratable(BillingObject);
export type Billing = BillingObject;
export const Blobs = migratable(BlobsObject);
export type Blobs = BlobsObject;
export const Cloudflare = migratable(CloudflareObject);
export type Cloudflare = CloudflareObject;
export const Codemode = migratable(CodemodeObject);
export type Codemode = CodemodeObject;
export const Forms = migratable(FormsObject);
export type Forms = FormsObject;
export const GitHub = migratable(GitHubObject);
export type GitHub = GitHubObject;
export const GitHubWebhookRouter = migratable(GitHubWebhookRouterObject);
export type GitHubWebhookRouter = GitHubWebhookRouterObject;
export const Marketplace = migratable(MarketplaceObject);
export type Marketplace = MarketplaceObject;
export const Mcp = migratable(McpObject);
export type Mcp = McpObject;
export const ProjectConnectorDurableObject = migratable(ProjectConnectorObject);
export type ProjectConnectorDurableObject = ProjectConnectorObject;
export const Otp = migratable(OtpObject);
export type Otp = OtpObject;
export const Pi = migratable(PiObject);
export type Pi = PiObject;
export const PiManager = migratable(PiManagerObject);
export type PiManager = PiManagerObject;
export const Presence = migratable(PresenceObject);
export type Presence = PresenceObject;
export const Resend = migratable(ResendObject);
export type Resend = ResendObject;
export const SandboxManager = migratable(SandboxManagerObject);
export type SandboxManager = SandboxManagerObject;
export const Telegram = migratable(TelegramObject);
export type Telegram = TelegramObject;
export const Upload = migratable(UploadObject);
export type Upload = UploadObject;
