import { InMemoryApiObject } from "../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../workers/apps.do";
import { InMemoryAuthObject } from "../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../workers/automations.do";
import { InMemoryBillingObject } from "../../workers/billing.do";
import { InMemoryCloudflareObject } from "../../workers/cloudflare.do";
import { InMemoryFormsObject } from "../../workers/forms.do";
import { InMemoryGitHubWebhookRouterObject } from "../../workers/github-webhook-router.do";
import { InMemoryGitHubObject } from "../../workers/github.do";
import {
  createPiDurableHarnessOptions,
  createPiDurableModels,
  listSupportedPiDurableModels,
} from "../../workers/lib/pi-durable-harness-options";
import { InMemoryMarketplaceObject } from "../../workers/marketplace.do";
import { InMemoryMcpObject } from "../../workers/mcp.do";
import { InMemoryOtpObject } from "../../workers/otp.do";
import { InMemoryPiManagerObject } from "../../workers/pi-manager.do";
import { InMemoryPiObject } from "../../workers/pi.do";
import { InMemoryProjectConnectorObject } from "../../workers/project-connector.do";
import { InMemoryResendObject } from "../../workers/resend.do";
import { InMemoryReson8Object } from "../../workers/reson8.do";
import { InMemorySandboxManagerObject } from "../../workers/sandbox-manager.do";
import { InMemoryTelegramObject } from "../../workers/telegram.do";
import { InMemoryUploadObject } from "../../workers/upload.do";
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
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  RESEND: (input) => new InMemoryResendObject(input),
  RESON8: (input) => new InMemoryReson8Object(input),
  MCP: (input) => new InMemoryMcpObject(input),
  PROJECT_CONNECTOR: (input) => new InMemoryProjectConnectorObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
  SANDBOX: () => new UnavailableLocalDurableObject(),
  SANDBOX_MANAGER: (input) =>
    new InMemorySandboxManagerObject({
      ...input,
      sandboxProviders: input.createSandboxProviders(input.state.id.toString()),
    }),
  GITHUB: (input) => new InMemoryGitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new InMemoryGitHubWebhookRouterObject(input),
  CLOUDFLARE: (input) => new InMemoryCloudflareObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  PI: (input) =>
    new InMemoryPiObject({
      ...input,
      options: createPiDurableHarnessOptions(input.env),
      openStorage: input.openPiSessionStore,
      idFromConfig: input.piAgentIdFromConfig,
    }),
  PI_MANAGER: (input) => {
    const { piAvailableModels } = input;
    const supportedAvailableModels = piAvailableModels
      ? async () => piAvailableModels
      : (() => {
          const models = createPiDurableModels(input.env);
          return async () => await listSupportedPiDurableModels(models);
        })();
    return new InMemoryPiManagerObject({
      ...input,
      agent: input.getPiAgent,
      supportedAvailableModels,
    });
  },
  BILLING: (input) => new InMemoryBillingObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  MARKETPLACE: (input) => new InMemoryMarketplaceObject(input),
} satisfies Record<LocalObjectBindingName, LocalBackofficeObjectFactory<unknown>>;
