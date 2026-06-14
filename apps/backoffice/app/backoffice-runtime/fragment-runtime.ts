import type { BackofficeDatabaseAdapterFactory } from "./database-adapters";

export type BackofficeFragmentRuntimeOptions = {
  adapters: BackofficeDatabaseAdapterFactory;
};
