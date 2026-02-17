import type { migrate as migrateType } from "../mod";
import type { withDatabase as withDatabaseType } from "../with-database";

export {
  createHandlerTxBuilder,
  createServiceTxBuilder,
  ServiceTxBuilder,
  HandlerTxBuilder,
  type TxResult,
  type ServiceBuilderMutateContext,
  type HandlerBuilderMutateContext,
  type BuilderTransformContextWithMutate,
  type BuilderTransformContextWithoutMutate,
  type ExtractServiceRetrieveResults,
  type ExtractServiceFinalResults,
} from "../query/unit-of-work/execute-unit-of-work";

export {
  createUnitOfWork,
  UnitOfWork,
  TypedUnitOfWork,
  type IUnitOfWork,
  type IUnitOfWorkRestricted,
  type UOWCompiler,
  type UOWExecutor,
  type UOWDecoder,
} from "../query/unit-of-work/unit-of-work";

export {
  Cursor,
  decodeCursor,
  createCursorFromRecord,
  type CursorData,
  type CursorResult,
} from "../query/cursor";

export {
  dbNow,
  dbInterval,
  type DbNow,
  type DbInterval,
  type DbIntervalInput,
} from "../query/db-now";

export const withDatabase: typeof withDatabaseType = () => {
  throw new Error("withDatabase is not available in browser builds.");
};

export const migrate: typeof migrateType = async () => {
  throw new Error("migrate is not available in browser builds.");
};

export { defineSyncCommands } from "../sync/commands";
export type {
  SubmitAppliedResponse,
  SubmitConflictReason,
  SubmitConflictResponse,
  SubmitRequest,
  SubmitResponse,
  SyncCommandDefinition,
  SyncCommandHandler,
  SyncCommandRegistry,
  SyncCommandTxFactory,
} from "../sync/types";
