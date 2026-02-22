export const WORKFLOW_EVENT_ACTOR_SYSTEM = "system";
export const WORKFLOW_EVENT_ACTOR_USER = "user";

export const WORKFLOW_SYSTEM_PAUSE_EVENT_TYPE = "pause";
export const WORKFLOW_SYSTEM_PAUSE_CONSUMER_KEY = "system:pause";

export const isSystemEventActor = (actor?: string | null) => actor === WORKFLOW_EVENT_ACTOR_SYSTEM;
