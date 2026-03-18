import {
  AUTOMATION_SOURCES,
  AUTOMATION_SOURCE_EVENT_TYPES,
  type AutomationSource,
} from "./contracts";

export type AutomationBuiltinScript = {
  key: string;
  name: string;
  engine: "bash";
  script: string;
  version: number;
  enabled?: boolean;
};

export type AutomationBuiltinTriggerBinding = {
  source: AutomationSource;
  eventType: string;
  scriptKey: string;
  scriptVersion?: number;
  enabled?: boolean;
};

export const telegramClaimLinkingStartScript = `if [ "\${AUTOMATION_TELEGRAM_TEXT:-}" != "/start" ]; then
  exit 0
fi

linked_user="$(
  automations.identity.lookup-binding \
    --source "$AUTOMATION_SOURCE" \
    --external-actor-id "$AUTOMATION_EXTERNAL_ACTOR_ID" \
    --print user-id || true
)"

if [ -n "$linked_user" ]; then
  event.reply --text "This Telegram chat is already linked."
  exit 0
fi

if ! claim_url="$(
  otp.identity.create-claim \
    --source "$AUTOMATION_SOURCE" \
    --external-actor-id "$AUTOMATION_EXTERNAL_ACTOR_ID" \
    --print url
)"; then
  echo "Failed to create Telegram identity claim URL" >&2
  exit 1
fi

if [ -z "$claim_url" ]; then
  echo "otp.identity.create-claim did not return a URL" >&2
  exit 1
fi

event.reply --text "Open this link to finish linking your Telegram account: $claim_url"
`;

export const telegramClaimLinkingCompleteScript = `link_source="$(jq -r '.linkSource // ""' /context/payload.json)"
external_actor_id="$(jq -r '.externalActorId // ""' /context/payload.json)"

reply_linking_status() {
  event.reply \
    --source "$link_source" \
    --external-actor-id "$external_actor_id" \
    --text "$1"
}

if [ "$link_source" != "telegram" ]; then
  exit 0
fi

if [ -z "$external_actor_id" ]; then
  echo "Missing externalActorId in identity claim payload" >&2
  exit 1
fi

if [ -z "$AUTOMATION_SUBJECT_USER_ID" ]; then
  reply_linking_status "We couldn't link your Telegram chat. Please try again."
  echo "Missing AUTOMATION_SUBJECT_USER_ID" >&2
  exit 1
fi

if automations.identity.bind-actor \
  --source "$link_source" \
  --external-actor-id "$external_actor_id" \
  --user-id "$AUTOMATION_SUBJECT_USER_ID" \
  >/dev/null; then
  reply_linking_status "Your Telegram chat is now linked."
  exit 0
fi

reply_linking_status "We couldn't link your Telegram chat. Please try again."
exit 1
`;

export const telegramCreatePiSessionScript = `if [ "\${AUTOMATION_TELEGRAM_TEXT:-}" != "/pi" ]; then
  exit 0
fi

if [ -z "\${AUTOMATION_PI_DEFAULT_AGENT:-}" ]; then
  event.reply --text "Pi session creation is not configured for this organisation."
  exit 0
fi

session_name="Telegram \${AUTOMATION_TELEGRAM_CHAT_ID:-session}"

if session_id="$(
  pi.session.create \
    --agent "$AUTOMATION_PI_DEFAULT_AGENT" \
    --name "$session_name" \
    --tag telegram \
    --tag auto-session \
    --print id
)"; then
  event.reply --text "Created Pi session: $session_id"
  exit 0
fi

event.reply --text "Failed to create a Pi session."
exit 1
`;

export const builtinAutomationScripts: AutomationBuiltinScript[] = [
  {
    key: "builtin.telegram-claim-linking.start",
    name: "Built-in Telegram claim linking start",
    engine: "bash",
    script: telegramClaimLinkingStartScript,
    version: 1,
    enabled: true,
  },
  {
    key: "builtin.telegram-claim-linking.complete",
    name: "Built-in Telegram claim linking completion",
    engine: "bash",
    script: telegramClaimLinkingCompleteScript,
    version: 1,
    enabled: true,
  },
  {
    key: "builtin.telegram-pi-session.start",
    name: "Temporary Telegram Pi session bootstrap",
    engine: "bash",
    script: telegramCreatePiSessionScript,
    version: 1,
    enabled: true,
  },
];

export const builtinAutomationBindings: AutomationBuiltinTriggerBinding[] = [
  {
    source: AUTOMATION_SOURCES.telegram,
    eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
    scriptKey: "builtin.telegram-claim-linking.start",
    scriptVersion: 1,
    enabled: true,
  },
  {
    source: AUTOMATION_SOURCES.otp,
    eventType: AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted,
    scriptKey: "builtin.telegram-claim-linking.complete",
    scriptVersion: 1,
    enabled: true,
  },
  {
    source: AUTOMATION_SOURCES.telegram,
    eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
    scriptKey: "builtin.telegram-pi-session.start",
    scriptVersion: 1,
    enabled: true,
  },
];
