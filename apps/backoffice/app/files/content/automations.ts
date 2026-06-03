import { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES } from "@/fragno/automation/contracts";

import type { FileSystemArtifact } from "../types";

export const STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH = "automations/bindings.json";

/**
 * Full starter automation bindings: trigger metadata, manifest script descriptor (absolute path under /workspace), and file body.
 * Order: telegram claim start → OTP complete → Pi session ensure.
 */
const STARTER_AUTOMATION_BINDINGS = [
  {
    id: "telegram-claim-linking-start",
    source: AUTOMATION_SOURCES.telegram,
    eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
    enabled: true,
    script: {
      key: "telegram-claim-linking.start",
      name: "Telegram claim linking start",
      engine: "bash" as const,
      path: "/workspace/automations/scripts/telegram-claim-linking.start.sh",
      version: 1,
      agent: null,
      env: {},
    },
    content: `#!/usr/bin/env bash
text="$(jq -r '.payload.text // ""' /context/event.json)"
source="$(jq -r '.source // ""' /context/event.json)"
external_actor_id="$(jq -r '.actor.externalId // ""' /context/event.json)"

if [ "$text" != "/start" ]; then
  exit 0
fi

linked_user="$(
  automations.identity.lookup-binding \
    --source "$source" \
    --key "$external_actor_id" \
    --print value || true
)"

if [ -n "$linked_user" ]; then
  telegram.chat.send -c "$external_actor_id" -t "This Telegram chat is already linked."
  exit 0
fi

if ! claim_url="$(
  otp.identity.create-claim \
    --source "$source" \
    --external-actor-id "$external_actor_id" \
    --print url
)"; then
  echo "Failed to create Telegram identity claim URL" >&2
  exit 1
fi

if [ -z "$claim_url" ]; then
  echo "otp.identity.create-claim did not return a URL" >&2
  exit 1
fi

telegram.chat.send -c "$external_actor_id" -t "Open this link to finish linking your Telegram account: $claim_url"
`,
  },
  {
    id: "telegram-claim-linking-complete",
    source: AUTOMATION_SOURCES.otp,
    eventType: AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted,
    enabled: true,
    script: {
      key: "telegram-claim-linking.complete",
      name: "Telegram claim linking completion",
      engine: "bash" as const,
      path: "/workspace/automations/scripts/telegram-claim-linking.complete.sh",
      version: 1,
      agent: null,
      env: {},
    },
    content: `#!/usr/bin/env bash
link_source="$(jq -r '.payload.linkSource // ""' /context/event.json)"
external_actor_id="$(jq -r '.payload.externalActorId // ""' /context/event.json)"
subject_user_id="$(jq -r '.subject.userId // ""' /context/event.json)"

reply_linking_status() {
  telegram.chat.send -c "$external_actor_id" -t "$1"
}

if [ "$link_source" != "telegram" ]; then
  exit 0
fi

if [ -z "$external_actor_id" ]; then
  echo "Missing externalActorId in identity claim payload" >&2
  exit 1
fi

if [ -z "$subject_user_id" ]; then
  reply_linking_status "We couldn't link your Telegram chat. Please try again."
  echo "Missing subject.userId in event" >&2
  exit 1
fi

if automations.identity.bind-actor \
  --source "$link_source" \
  --key "$external_actor_id" \
  --value "$subject_user_id" \
  >/dev/null; then
  reply_linking_status "Your Telegram chat is now linked."
  exit 0
fi

reply_linking_status "We couldn't link your Telegram chat. Please try again."
exit 1
`,
  },
  {
    id: "telegram-pi-session-ensure",
    source: AUTOMATION_SOURCES.telegram,
    eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
    enabled: true,
    script: {
      key: "telegram-pi-session.ensure",
      name: "Telegram Pi session ensure (linked chat)",
      engine: "bash" as const,
      path: "/workspace/automations/scripts/telegram-pi-session.ensure.sh",
      version: 1,
      agent: null,
      env: {},
    },
    content: `#!/usr/bin/env bash
if [ -z "\${PI_DEFAULT_AGENT:-}" ]; then
  exit 0
fi

external_actor_id="$(jq -r '.actor.externalId // ""' /context/event.json)"
text="$(jq -r '.payload.text // ""' /context/event.json)"
chat_id="$(jq -r '.payload.chatId // ""' /context/event.json)"

# Only bootstrap Pi sessions for identity-linked Telegram chats.
linked_user="$(
  automations.identity.lookup-binding \
    --source "telegram" \
    --key "$external_actor_id" \
    --print value || true
)"

if [ -z "$linked_user" ]; then
  exit 0
fi

binding_source="telegram-pi-session"
# Use the linked user id as the storage key so sessions are per-user (not per-chat).
binding_key="$linked_user"

pi_session_id="$(
  automations.identity.lookup-binding \
    --source "$binding_source" \
    --key "$binding_key" \
    --print value || true
)"

terminal_session=false
if [ -n "$pi_session_id" ]; then
  session_status="$(pi.session.get \
    --session-id "$pi_session_id" \
    --print workflow.status \
    2>/dev/null || true
  )"

  case "$session_status" in
    terminated | complete | errored)
      terminal_session=true
      ;;
    "")
      terminal_session=true
      ;;
  esac
fi

if [ -z "$pi_session_id" ] || [ "$terminal_session" = "true" ]; then
  session_name="Telegram \${chat_id:-$external_actor_id}"

  if new_session_id="$(
    pi.session.create \
      --agent "$PI_DEFAULT_AGENT" \
      --name "$session_name" \
      --tag telegram \
      --tag auto-session \
      --print id \\
      --system-message "IMPORTANT:ALL non-tool call output will AUTOMATICALLY be forwarded to Telegram in Markdown parse mode."
  )"; then
    automations.identity.bind-actor \
      --source "$binding_source" \
      --key "$binding_key" \
      --value "$new_session_id" \
      --description "Pi session for Telegram chat $external_actor_id" \
      >/dev/null || exit 1

    pi_session_id="$new_session_id"

    if [ "$text" = "/pi" ]; then
      telegram.chat.send -c "\${chat_id:-$external_actor_id}" -t "Created Pi session: $new_session_id"
      exit 0
    fi
  else
    exit 1
  fi
fi

if [ -z "$text" ]; then
  exit 0
fi

if [ "$text" = "/pi" ]; then
  exit 0
fi

telegram.chat.actions -c "\${chat_id:-$external_actor_id}" --action typing

assistant_text="$(
  pi.session.turn \
    --session-id "$pi_session_id" \
    --text "$text" \
    --print assistantText
)" || exit 1

if [ -n "$assistant_text" ]; then
  telegram.chat.send -c "\${chat_id:-$external_actor_id}" -t "$assistant_text"
fi

exit 0
`,
  },
] as const;

export const STARTER_AUTOMATION_SCRIPT_PATHS = {
  telegramClaimLinkingStart: STARTER_AUTOMATION_BINDINGS[0].script.path.slice("/workspace/".length),
  telegramClaimLinkingComplete: STARTER_AUTOMATION_BINDINGS[1].script.path.slice(
    "/workspace/".length,
  ),
  telegramPiSessionEnsure: STARTER_AUTOMATION_BINDINGS[2].script.path.slice("/workspace/".length),
} as const;

const STARTER_AUTOMATION_MANIFEST = {
  version: 1 as const,
  bindings: STARTER_AUTOMATION_BINDINGS.map((b) => ({
    id: b.id,
    source: b.source,
    eventType: b.eventType,
    enabled: b.enabled,
    script: b.script,
  })),
};

export const STARTER_AUTOMATION_CONTENT = {
  [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: `${JSON.stringify(STARTER_AUTOMATION_MANIFEST, null, 2)}\n`,
  ...Object.fromEntries(
    STARTER_AUTOMATION_BINDINGS.map((b) => [b.script.path.slice("/workspace/".length), b.content]),
  ),
} satisfies Record<string, FileSystemArtifact>;
