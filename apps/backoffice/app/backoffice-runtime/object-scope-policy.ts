import type { BackofficeObjectAddress, BackofficeObjectBindingName } from "./object-registry";

export type BackofficeObjectScopeKind = BackofficeObjectAddress["scope"]["kind"];

export const backofficeObjectScopePolicy = {
  AUTH: ["singleton"],

  AUTOMATIONS: ["singleton", "org", "user", "project"],

  TELEGRAM: ["org"],
  OTP: ["org"],
  RESEND: ["org"],
  RESON8: ["org"],
  MCP: ["org", "user"],
  UPLOAD: ["org", "user", "project"],
  GITHUB: ["org"],
  CLOUDFLARE_WORKERS: ["org"],

  PI: ["org"],

  GITHUB_WEBHOOK_ROUTER: ["singleton"],

  SANDBOX_REGISTRY: ["org"],

  SANDBOX: ["named"],
} satisfies Record<BackofficeObjectBindingName, readonly BackofficeObjectScopeKind[]>;

export const assertBackofficeObjectAddressAllowed = (address: BackofficeObjectAddress) => {
  const allowedScopes: readonly BackofficeObjectScopeKind[] =
    backofficeObjectScopePolicy[address.binding];
  if (!allowedScopes.includes(address.scope.kind)) {
    throw new Error(
      `Backoffice object ${address.binding} cannot be instantiated with ${address.scope.kind} scope. Allowed scopes: ${allowedScopes.join(", ")}.`,
    );
  }
};
