import type { DatabaseAdapter } from "@fragno-dev/db";

// The concrete Backoffice adapters use different UnitOfWork config types (Cloudflare SQL,
// in-memory, etc.). Callers pass the adapter straight into Fragno fragments, so the factory must
// preserve that adapter-level flexibility.
type AnyBackofficeDatabaseAdapter = DatabaseAdapter<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type BackofficeDatabaseAdapterKind =
  | "api"
  | "auth"
  | "automations"
  | "github"
  | "mcp"
  | "otp"
  | "pi"
  | "resend"
  | "reson8"
  | "telegram"
  | "upload"
  | "workflows";

export type BackofficeDatabaseAdapterScope =
  | {
      type: "durableObject";
      id: string;
      state: DurableObjectState;
    }
  | {
      type: "named";
      id: string;
    };

export const createDurableObjectDatabaseAdapterScope = (
  state: DurableObjectState,
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
