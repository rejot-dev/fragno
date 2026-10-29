import { blobsR2BucketsFromEnv } from "@/fragno/blobs-server";
import { createPiAgentDependencies } from "@/fragno/pi/agent/pi-agent-harness";
import {
  createPiClassifier,
  createPiImageGenerator,
  createPiExtractor,
  createPiModels,
  listAvailablePiModels,
} from "@/fragno/pi/agent/pi-models";

import { ApiObject } from "../../workers/api-object";
import { AppInstallationsObject } from "../../workers/app-installations-object";
import { AppsObject } from "../../workers/apps-object";
import { AuthObject } from "../../workers/auth-object";
import { AutomationsObject } from "../../workers/automations-object";
import { BillingObject } from "../../workers/billing-object";
import { BlobsObject } from "../../workers/blobs-object";
import { CloudflareObject } from "../../workers/cloudflare-object";
import { CodemodeObject } from "../../workers/codemode-object";
import { FormsObject } from "../../workers/forms-object";
import { GitHubObject } from "../../workers/github-object";
import { GitHubWebhookRouterObject } from "../../workers/github-webhook-router-object";
import { MarketplaceObject } from "../../workers/marketplace-object";
import { McpObject } from "../../workers/mcp-object";
import { OtpObject } from "../../workers/otp-object";
import { PiManagerObject } from "../../workers/pi-manager-object";
import { PiObject } from "../../workers/pi-object";
import { PresenceObject } from "../../workers/presence-object";
import { ProjectConnectorObject } from "../../workers/project-connector-object";
import { ResendObject } from "../../workers/resend-object";
import { SandboxManagerObject } from "../../workers/sandbox-manager-object";
import { TelegramObject } from "../../workers/telegram-object";
import { UploadObject } from "../../workers/upload-object";
import type { LocalBackofficeObjectFactory, LocalObjectBindingName } from "./local-object-factory";

class UnavailableLocalDurableObject {
  async fetch() {
    return Response.json({ message: "Not configured", code: "NOT_CONFIGURED" }, { status: 400 });
  }

  async alarm() {}

  async getAdminConfig() {
    return { configured: false };
  }

  async resetAdminConfig() {
    return { configured: false };
  }

  async setAdminConfig() {
    return { configured: false };
  }

  async queueEmail() {
    throw new Error("Resend is not configured.");
  }

  async getDurableHookQueue() {
    return {
      configured: false,
      hooksEnabled: false,
      namespace: null,
      items: [],
      cursor: undefined,
      hasNextPage: false,
    };
  }

  async getDurableHook() {
    return null;
  }

  async wakeDurableHooks() {}

  async getUserAuthorityFacts() {
    return {
      active: false,
      role: null,
      jurisdiction: null,
      organization: null,
    } as const;
  }

  async findAdministeredMember() {
    return null;
  }

  async findRootOwnerScope() {
    return null;
  }

  async getUserOrganizationAuthorityFacts() {
    return {
      active: false,
      role: null,
      organizationRoles: null,
    } as const;
  }

  async getAllOrganizations() {
    return [];
  }

  async getOrganizationBySlug() {
    return null;
  }

  async hasOrganizationMember() {
    return false;
  }

  async getDevOrganizations() {
    return [];
  }

  async ensureAdminConfig() {
    return { configured: false };
  }

  async redeliverFailedInstallationWebhooks() {}

  async resolveProjectForExecution() {
    return null;
  }

  async listSandboxInstances() {
    return [];
  }

  async getSandboxInstance() {
    return null;
  }

  async requestSandboxInstance() {
    throw new Error("Automations is not configured.");
  }

  async requestSandboxInstanceStop() {
    return null;
  }

  async requestMarketplacePackagePublish() {
    throw new Error("Automations is not configured.");
  }

  async requestStaticMarketplacePublications() {
    throw new Error("Automations is not configured.");
  }

  async requestMarketplaceIngestion() {
    throw new Error("Automations is not configured.");
  }

  async restartMarketplaceIngestion() {
    throw new Error("Automations is not configured.");
  }

  async getRuntimeStatus() {
    return { status: "stopped" };
  }

  async getRealtimeOriginDiagnostic() {
    return null;
  }
}

/**
 * Every object the Node server runs. Importing this loads every object implementation and its
 * SDKs; tests that use a few objects should construct only those.
 */
export const allLocalObjects = {
  API: (input) => new ApiObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  TELEGRAM: (input) => new TelegramObject(input),
  RESEND: (input) => new ResendObject(input),
  MCP: (input) => new McpObject(input),
  PROJECT_CONNECTOR: (input) => new ProjectConnectorObject(input),
  OTP: (input) => new OtpObject(input),
  UPLOAD: (input) => new UploadObject(input),
  BLOBS: (input) => {
    // Local objects are not kept in jurisdictions, so neither are their blobs.
    const buckets = blobsR2BucketsFromEnv(input.env, "local");
    return new BlobsObject({ ...input, storage: buckets ? { buckets, fetch } : null });
  },
  SANDBOX: () => new UnavailableLocalDurableObject(),
  SANDBOX_MANAGER: (input) =>
    new SandboxManagerObject({
      ...input,
      sandboxProviders: input.createSandboxProviders(input.state.id.toString()),
    }),
  GITHUB: (input) => new GitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new GitHubWebhookRouterObject(input),
  CLOUDFLARE: (input) => new CloudflareObject(input),
  FORMS: (input) => new FormsObject(input),
  PRESENCE: (input) => new PresenceObject(input),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  PI: (input) =>
    new PiObject({
      ...input,
      dependencies: createPiAgentDependencies(input.env),
      openStorage: input.openPiSessionStore,
      idFromConfig: input.piAgentIdFromConfig,
    }),
  PI_MANAGER: (input) => {
    const { piAvailableModels } = input;
    const supportedAvailableModels = piAvailableModels
      ? async () => piAvailableModels
      : (() => {
          const models = createPiModels(input.env);
          return async () => await listAvailablePiModels(models);
        })();
    return new PiManagerObject({
      ...input,
      agent: input.getPiAgent,
      supportedAvailableModels,
      classifier: createPiClassifier(input.env, fetch),
      imageGenerator: createPiImageGenerator(input.env, fetch),
      extractor: createPiExtractor(input.env, fetch),
      // Workers AI runs only through a Worker's `AI` binding.
      workersAi: null,
    });
  },
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  MARKETPLACE: (input) => new MarketplaceObject(input),
} satisfies Record<LocalObjectBindingName, LocalBackofficeObjectFactory<unknown>>;
