import { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES } from "@/fragno/automation/contracts";

import type { FileSystemArtifact } from "../types";

export const STARTER_AUTOMATION_ROOT = "automations";
export const STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH = `${STARTER_AUTOMATION_ROOT}/bindings.json`;

export const STARTER_AUTOMATION_SCRIPT_PATHS = {
  telegramClaimLinkingStart: `${STARTER_AUTOMATION_ROOT}/scripts/telegram-claim-linking.start.sh`,
  telegramClaimLinkingComplete: `${STARTER_AUTOMATION_ROOT}/scripts/telegram-claim-linking.complete.sh`,
  telegramPiSessionStart: `${STARTER_AUTOMATION_ROOT}/scripts/telegram-pi-session.start.sh`,
} as const;

export const starterTelegramClaimLinkingStartScript = `if [ "\${AUTOMATION_TELEGRAM_TEXT:-}" != "/start" ]; then
  exit 0
fi

linked_user="$(
  automations.identity.lookup-binding \
    --source "$AUTOMATION_SOURCE" \
    --key "$AUTOMATION_EXTERNAL_ACTOR_ID" \
    --print value || true
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

export const starterTelegramClaimLinkingCompleteScript = `link_source="$(jq -r '.linkSource // ""' /context/payload.json)"
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
  --key "$external_actor_id" \
  --value "$AUTOMATION_SUBJECT_USER_ID" \
  >/dev/null; then
  reply_linking_status "Your Telegram chat is now linked."
  exit 0
fi

reply_linking_status "We couldn't link your Telegram chat. Please try again."
exit 1
`;

export const starterTelegramPiSessionStartScript = `if [ "\${AUTOMATION_TELEGRAM_TEXT:-}" != "/pi" ]; then
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

const STARTER_AUTOMATION_MANIFEST = {
  version: 1,
  bindings: [
    {
      id: "telegram-claim-linking-start",
      source: AUTOMATION_SOURCES.telegram,
      eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
      enabled: true,
      script: {
        key: "telegram-claim-linking.start",
        name: "Telegram claim linking start",
        engine: "bash",
        path: "scripts/telegram-claim-linking.start.sh",
        version: 1,
        agent: null,
        env: {},
      },
    },
    {
      id: "telegram-claim-linking-complete",
      source: AUTOMATION_SOURCES.otp,
      eventType: AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted,
      enabled: true,
      script: {
        key: "telegram-claim-linking.complete",
        name: "Telegram claim linking completion",
        engine: "bash",
        path: "scripts/telegram-claim-linking.complete.sh",
        version: 1,
        agent: null,
        env: {},
      },
    },
    {
      id: "telegram-pi-session-start",
      source: AUTOMATION_SOURCES.telegram,
      eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
      enabled: true,
      script: {
        key: "telegram-pi-session.start",
        name: "Telegram Pi session bootstrap",
        engine: "bash",
        path: "scripts/telegram-pi-session.start.sh",
        version: 1,
        agent: null,
        env: {},
      },
    },
  ],
} as const;

export const STARTER_AUTOMATION_CONTENT = {
  [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: `${JSON.stringify(STARTER_AUTOMATION_MANIFEST, null, 2)}\n`,
  [STARTER_AUTOMATION_SCRIPT_PATHS.telegramClaimLinkingStart]:
    starterTelegramClaimLinkingStartScript,
  [STARTER_AUTOMATION_SCRIPT_PATHS.telegramClaimLinkingComplete]:
    starterTelegramClaimLinkingCompleteScript,
  [STARTER_AUTOMATION_SCRIPT_PATHS.telegramPiSessionStart]: starterTelegramPiSessionStartScript,
} satisfies Record<string, FileSystemArtifact>;
