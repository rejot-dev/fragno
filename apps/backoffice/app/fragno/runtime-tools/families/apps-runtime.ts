import type {
  BackofficeAppInstallation,
  BackofficeAppInstallationGrantsInput,
  BackofficeAppInstallationMutationResult,
  BackofficeAppInstallationPage,
  BackofficeAppInstallationPageInput,
  BackofficeAppInstallationsCommands,
} from "@/fragno/app-installations/contracts";
import type {
  BackofficeApp,
  BackofficeAppLookupInput,
  BackofficeAppsCommands,
} from "@/fragno/apps/contracts";
import { requireBackofficeAppOperationValue } from "@/fragno/apps/errors";

export type AppsRuntime = {
  getApp(input: BackofficeAppLookupInput): Promise<BackofficeApp | null>;
  installApp(
    input: BackofficeAppInstallationGrantsInput,
    installedByUserId: string,
  ): Promise<BackofficeAppInstallationMutationResult>;
  getInstallation(input: BackofficeAppLookupInput): Promise<BackofficeAppInstallation | null>;
  listInstallations(
    input: BackofficeAppInstallationPageInput,
  ): Promise<BackofficeAppInstallationPage>;
  updateInstallationGrants(
    input: BackofficeAppInstallationGrantsInput,
  ): Promise<BackofficeAppInstallationMutationResult>;
  uninstallApp(input: BackofficeAppLookupInput): Promise<BackofficeAppInstallationMutationResult>;
};

/** Objects are bound to the selected organization before exposing this control-plane runtime. */
export function createAppsRuntime({
  apps,
  installations,
}: {
  apps: BackofficeAppsCommands | null;
  installations: BackofficeAppInstallationsCommands;
}): AppsRuntime {
  return {
    getApp: async (input) => {
      if (!apps) {
        throw new Error("App declaration review requires the APPS binding.");
      }
      return await apps.getApp(input);
    },
    installApp: async (input, installedByUserId) =>
      requireBackofficeAppOperationValue(
        await installations.installApp({ ...input, installedByUserId }),
      ),
    getInstallation: async (input) => await installations.getInstallation(input),
    listInstallations: async (input) =>
      requireBackofficeAppOperationValue(await installations.listInstallations(input)),
    updateInstallationGrants: async (input) =>
      requireBackofficeAppOperationValue(await installations.updateInstallationGrants(input)),
    uninstallApp: async (input) =>
      requireBackofficeAppOperationValue(await installations.uninstallApp(input)),
  };
}
