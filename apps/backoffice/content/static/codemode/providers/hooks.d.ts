// Durable hook queues. Read to debug stuck or retrying background delivery.
type HooksCodemodeProvider = {
  /**
   * List hook scopes usable with hooks.list --fragment.
   * Requires `hooks.read`.
   */
  scopesList(): Promise<HooksScopesListOutput>;
  /**
   * List durable hook queue entries for a runtime fragment.
   * Requires `hooks.read`.
   */
  list(input: HooksListInput): Promise<HooksListOutput>;
  /**
   * Get a durable hook queue entry by id. An automations ingest entry's payload is the event envelope, so the event's own payload is at payload.payload.
   * Requires `hooks.read`.
   */
  get(input: HooksGetInput): Promise<HooksGetOutput>;
};
declare const hooks: HooksCodemodeProvider;

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
