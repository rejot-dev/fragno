import type { DatabaseTransactionInstrumentation } from "@fragno-dev/db/transaction-instrumentation";

import type { BackofficeDatabaseAdapterFactory } from "./database-adapters";

export type BackofficeFragmentRuntimeOptions = {
  adapters: BackofficeDatabaseAdapterFactory;
  transactionInstrumentation?: DatabaseTransactionInstrumentation;
};
