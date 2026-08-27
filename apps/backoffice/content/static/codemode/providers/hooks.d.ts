// hooks tools
type HooksCodemodeProvider = {
  /** List hook scopes usable with hooks.list --fragment. */
  scopesList(input: HooksScopesListInput): Promise<HooksScopesListOutput>;
  /** List durable hook queue entries for a runtime fragment. */
  list(input: HooksListInput): Promise<HooksListOutput>;
  /** Get a durable hook queue entry by id. */
  get(input: HooksGetInput): Promise<HooksGetOutput>;
};
declare const hooks: HooksCodemodeProvider;

type HooksScopesListInput = Record<string, unknown>;
type HooksScopesListOutput = {
  id: string;
  label: string;
  capabilityId: string;
  capabilityLabel: string;
  kind: "connection" | "system";
  configured?: boolean;
  healthy?: boolean;
}[];
type HooksListInput = {
  fragment: string;
  cursor?: string;
  pageSize?: number;
};
type HooksListOutput = {
  configured: boolean;
  hooksEnabled: boolean;
  namespace: string | null;
  items: {
    id: string;
    hookName: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    lastAttemptAt: string | null;
    nextRetryAt: string | null;
    createdAt: string | null;
    error: string | null;
    payload: unknown;
  }[];
  cursor?: string;
  hasNextPage: boolean;
};
type HooksGetInput = {
  fragment: string;
  hookId: string;
};
type HooksGetOutput = {
  id: string;
  hookName: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  createdAt: string | null;
  error: string | null;
  payload: unknown;
} | null;
