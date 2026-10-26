import { createPiAgentDependencies } from "@/fragno/pi/agent/pi-agent-harness";
import {
  createPiClassifier,
  createPiImageGenerator,
  createPiModels,
  listAvailablePiModels,
} from "@/fragno/pi/agent/pi-models";

import { ApiObject } from "../../workers/api.do";
import { AppInstallationsObject } from "../../workers/app-installations.do";
import { AppsObject } from "../../workers/apps.do";
import { AuthObject } from "../../workers/auth.do";
import { AutomationsObject } from "../../workers/automations.do";
import { BillingObject } from "../../workers/billing.do";
import { CloudflareObject } from "../../workers/cloudflare.do";
import { CodemodeObject } from "../../workers/codemode.do";
import { FormsObject } from "../../workers/forms.do";
import { GitHubWebhookRouterObject } from "../../workers/github-webhook-router.do";
import { GitHubObject } from "../../workers/github.do";
import { MarketplaceObject } from "../../workers/marketplace.do";
import { McpObject } from "../../workers/mcp.do";
import { OtpObject } from "../../workers/otp.do";
import { PiManagerObject } from "../../workers/pi-manager.do";
import { PiObject } from "../../workers/pi.do";
import { PresenceObject } from "../../workers/presence.do";
import { ProjectConnectorObject } from "../../workers/project-connector.do";
import { ResendObject } from "../../workers/resend.do";
import { SandboxManagerObject } from "../../workers/sandbox-manager.do";
import { TelegramObject } from "../../workers/telegram.do";
import { UploadObject } from "../../workers/upload.do";
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

  async getUserAuthorityFacts() {
    return {
      active: false,
      role: null,
      organizationMember: false,
    } as const;
  }

  async findAdministeredMember() {
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
    });
  },
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  MARKETPLACE: (input) => new MarketplaceObject(input),
} satisfies Record<LocalObjectBindingName, LocalBackofficeObjectFactory<unknown>>;
