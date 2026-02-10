import type { RequestThisContext } from "@fragno-dev/core";
import type {
  ExecuteTxOptions,
  HandlerTxBuilder,
} from "../query/unit-of-work/execute-unit-of-work";
import type { OutboxEntry } from "../outbox/outbox";

export type SubmitRequest = {
  baseVersionstamp?: string;
  requestId: string;
  conflictResolutionStrategy: "server" | "disabled";
  adapterIdentity: string;
  commands: Array<{
    id: string;
    name: string;
    target: {
      fragment: string;
      schema: string;
    };
    input: unknown;
  }>;
};

export type SubmitConflictReason =
  | "conflict"
  | "write_congestion"
  | "client_far_behind"
  | "no_commands"
  | "already_handled"
  | "limit_exceeded";

export type SubmitAppliedResponse = {
  status: "applied";
  requestId: string;
  confirmedCommandIds: string[];
  lastVersionstamp?: string;
  entries: OutboxEntry[];
};

export type SubmitConflictResponse = {
  status: "conflict";
  requestId: string;
  confirmedCommandIds: string[];
  conflictCommandId?: string;
  lastVersionstamp?: string;
  entries: OutboxEntry[];
  reason: SubmitConflictReason;
};

export type SubmitResponse = SubmitAppliedResponse | SubmitConflictResponse;

export type SyncCommandTxFactory = (
  options?: Omit<ExecuteTxOptions, "createUnitOfWork">,
) => HandlerTxBuilder<readonly [], [], [], unknown, unknown, false, false, false, false, {}>;

export type SyncCommandHandler<TInput = unknown, TContext = unknown> = (args: {
  input: TInput;
  tx: SyncCommandTxFactory;
  ctx: TContext;
}) => Promise<unknown>;

export type SyncCommandDefinition<TInput = unknown, TContext = unknown> = {
  name: string;
  handler: SyncCommandHandler<TInput, TContext>;
  createServerContext?: (requestContext: RequestThisContext) => TContext;
};

export type SyncCommandRegistry = {
  schemaName: string;
  commands: Map<string, SyncCommandDefinition>;
  getCommand: (name: string) => SyncCommandDefinition | undefined;
};

export type SyncCommandTargetRegistration = {
  fragmentName: string;
  schemaName: string;
  namespace: string | null;
  commands: Map<string, SyncCommandDefinition>;
};
