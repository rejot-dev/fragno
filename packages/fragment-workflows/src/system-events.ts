export const WORKFLOW_EVENT_ACTOR_SYSTEM = "system";
export const WORKFLOW_EVENT_ACTOR_USER = "user";

/** Built-in workflow actors with extension support for application-defined actors. */
export type WorkflowEventActor =
  | typeof WORKFLOW_EVENT_ACTOR_SYSTEM
  | typeof WORKFLOW_EVENT_ACTOR_USER
  | (string & Record<never, never>);

export const WORKFLOW_SYSTEM_PAUSE_EVENT_TYPE = "pause";
export const WORKFLOW_SYSTEM_PAUSE_CONSUMER_KEY = "system:pause";

export const isSystemEventActor = (actor?: string | null) => actor === WORKFLOW_EVENT_ACTOR_SYSTEM;
