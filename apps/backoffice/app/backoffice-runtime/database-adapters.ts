import type { DODialectConfig } from "@fragno-dev/db/dialects/durable-object";

import type { DatabaseAdapter } from "@fragno-dev/db";

// The concrete Backoffice adapters use different UnitOfWork config types (Cloudflare SQL,
// in-memory, etc.). Callers pass the adapter straight into Fragno fragments, so the factory must
// preserve that adapter-level flexibility.
type AnyBackofficeDatabaseAdapter = DatabaseAdapter<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type BackofficeDatabaseAdapterKind =
  | "api"
  | "auth"
  | "automations"
  | "sandbox-manager"
  | "billing"
  | "cloudflare"
  | "forms"
  | "marketplace"
  | "github"
  | "mcp"
  | "projectConnector"
  | "otp"
  | "pi"
  | "pi-manager"
  | "resend"
  | "reson8"
  | "telegram"
  | "upload"
  | "workflows";

export type BackofficeDatabaseAdapterScope =
  | {
      type: "durableObject";
      id: string;
      state: DODialectConfig["ctx"];
    }
  | {
      type: "named";
      id: string;
    };

export const createDurableObjectDatabaseAdapterScope = (
  state: DODialectConfig["ctx"],
): BackofficeDatabaseAdapterScope => ({
  type: "durableObject",
  id: state.id.toString(),
  state,
});

export type CreateBackofficeDatabaseAdapterInput = {
  kind: BackofficeDatabaseAdapterKind;
  databaseName?: string;
};

export type BackofficeDatabaseAdapterFactory = {
  createAdapter(input: CreateBackofficeDatabaseAdapterInput): AnyBackofficeDatabaseAdapter;
  forScope(scope: BackofficeDatabaseAdapterScope): BackofficeDatabaseAdapterFactory;
};
