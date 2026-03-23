import { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES } from "@/fragno/automation/contracts";

import type { FileSystemArtifact } from "../types";

export const STARTER_AUTOMATION_ROOT = "automations";
export const STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH = `${STARTER_AUTOMATION_ROOT}/bindings.json`;

export const STARTER_AUTOMATION_SCRIPT_PATHS = {
  telegramClaimLinkingStart: `${STARTER_AUTOMATION_ROOT}/scripts/telegram-claim-linking.start.sh`,
  telegramClaimLinkingComplete: `${STARTER_AUTOMATION_ROOT}/scripts/telegram-claim-linking.complete.sh`,
  telegramPiSessionEnsure: `${STARTER_AUTOMATION_ROOT}/scripts/telegram-pi-session.ensure.sh`,
} as const;

export const STARTER_AUTOMATION_SIMULATOR_ROOT = `${STARTER_AUTOMATION_ROOT}/simulator`;
export const STARTER_AUTOMATION_SCENARIO_ROOT = `${STARTER_AUTOMATION_SIMULATOR_ROOT}/scenarios`;

export const STARTER_AUTOMATION_SIMULATOR_PATHS = {
  readme: `${STARTER_AUTOMATION_SIMULATOR_ROOT}/README.md`,
  telegramClaimLinking: `${STARTER_AUTOMATION_SCENARIO_ROOT}/telegram-claim-linking.json`,
  telegramPiSession: `${STARTER_AUTOMATION_SCENARIO_ROOT}/telegram-pi-session.json`,
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

export const starterTelegramPiSessionEnsureScript = `
if [ -z "\${AUTOMATION_PI_DEFAULT_AGENT:-}" ]; then
  exit 0
fi

# Only bootstrap Pi sessions for identity-linked Telegram chats.
linked_user="$(
  automations.identity.lookup-binding \
    --source "telegram" \
    --key "$AUTOMATION_EXTERNAL_ACTOR_ID" \
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
  session_name="Telegram \${AUTOMATION_TELEGRAM_CHAT_ID:-$AUTOMATION_EXTERNAL_ACTOR_ID}"

  if new_session_id="$(
    pi.session.create \
      --agent "$AUTOMATION_PI_DEFAULT_AGENT" \
      --name "$session_name" \
      --tag telegram \
      --tag auto-session \
      --print id
  )"; then
    automations.identity.bind-actor \
      --source "$binding_source" \
      --key "$binding_key" \
      --value "$new_session_id" \
      --description "Pi session for Telegram chat $AUTOMATION_EXTERNAL_ACTOR_ID" \
      >/dev/null || exit 1

    pi_session_id="$new_session_id"

    if [ "\${AUTOMATION_TELEGRAM_TEXT:-}" = "/pi" ]; then
      event.reply --text "Created Pi session: $new_session_id"
      exit 0
    fi
  else
    exit 1
  fi
fi

if [ -z "\${AUTOMATION_TELEGRAM_TEXT:-}" ]; then
  exit 0
fi

if [ "\${AUTOMATION_TELEGRAM_TEXT:-}" = "/pi" ]; then
  exit 0
fi

assistant_text="$(
  pi.session.turn \
    --session-id "$pi_session_id" \
    --text "$AUTOMATION_TELEGRAM_TEXT" \
    --print assistantText
)" || exit 1

if [ -n "$assistant_text" ]; then
  event.reply --text "$assistant_text"
fi

exit 0
`;

export const starterAutomationSimulatorReadme = `# Automation simulator

Use the scenario DSL in this folder to run the real automation workspace files against mock command state.

## What it uses

- \`../bindings.json\`
- \`../scripts/*.sh\`
- plain JSON scenarios under \`./scenarios\`

## Scenario shape

Each scenario is plain data so the same file can power repo tests today and a Backoffice UI later.

Required fields:

- \`version\`: currently \`1\`
- \`name\`: human-readable label
- \`steps[]\`: one or more events to ingest in order

Useful optional fields:

- \`env\`: global bash env overrides applied to every step
- \`initialState\`: starting identity bindings, claims, Pi sessions, replies, and emitted events
- \`commandMocks\`: ordered mock results for custom commands like \`event.reply\`, \`otp.identity.create-claim\`, \`pi.session.create\`, \`pi.session.get\`, and \`pi.session.turn\`
- \`expectations\`: documentation-only examples of the transcript or final state you expect

The simulator keeps state across steps, records a normalized transcript, and stops a step when a binding exits non-zero.

To bridge an external automation event into an existing Pi session, use \`pi.session.turn\` with a stable session binding and print the final assistant text:

\`\`\`bash
assistant_text="$(
  pi.session.turn \\
    --session-id "$pi_session_id" \\
    --text "$AUTOMATION_TELEGRAM_TEXT" \\
    --print assistantText
)"

event.reply --text "$assistant_text"
\`\`\`
`;

const STARTER_TELEGRAM_CLAIM_LINKING_SCENARIO = {
  version: 1,
  name: "Starter Telegram claim-linking flow",
  description:
    "Runs the real starter automation files across /start -> OTP completion -> /start using shared mock state.",
  commandMocks: {
    "otp.identity.create-claim": {
      results: [
        {
          data: {
            url: "https://example.com/claims/chat-1",
            externalId: "chat-1",
            code: "123456",
            type: "otp",
          },
        },
      ],
      onExhausted: "default",
    },
  },
  steps: [
    {
      id: "telegram-start",
      event: {
        id: "event-telegram-start-1",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {
          text: "/start",
          chatId: "chat-1",
        },
        actor: {
          type: "external",
          externalId: "chat-1",
        },
      },
    },
    {
      id: "otp-complete",
      event: {
        id: "event-otp-1",
        orgId: "org-1",
        source: "otp",
        eventType: "identity.claim.completed",
        occurredAt: "2026-01-01T00:01:00.000Z",
        payload: {
          linkSource: "telegram",
          externalActorId: "chat-1",
        },
        actor: null,
        subject: {
          userId: "user-1",
        },
      },
    },
    {
      id: "telegram-start-again",
      event: {
        id: "event-telegram-start-2",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:02:00.000Z",
        payload: {
          text: "/start",
          chatId: "chat-1",
        },
        actor: {
          type: "external",
          externalId: "chat-1",
        },
      },
    },
  ],
  expectations: {
    replies: [
      "Open this link to finish linking your Telegram account: https://example.com/claims/chat-1",
      "Your Telegram chat is now linked.",
      "This Telegram chat is already linked.",
    ],
    identityBindings: [
      {
        source: "telegram",
        key: "chat-1",
        value: "user-1",
      },
    ],
  },
} as const;

const STARTER_TELEGRAM_PI_SESSION_SCENARIO = {
  version: 1,
  name: "Starter Telegram Pi session bootstrap + turns",
  description:
    "Ensures the real starter Telegram Pi script can create and bind a Pi session, then forward follow-up Telegram messages into that session.",
  env: {
    AUTOMATION_PI_DEFAULT_AGENT: "default::openai::gpt-5-mini",
  },
  initialState: {
    identityBindings: [
      {
        source: "telegram",
        key: "chat-1",
        value: "user-1",
        status: "linked",
      },
    ],
  },
  commandMocks: {
    "pi.session.create": {
      results: [
        {
          data: {
            id: "session-for-default::openai::gpt-5-mini",
            agent: "default::openai::gpt-5-mini",
            name: "Telegram chat-1",
            status: "waiting",
            steeringMode: "one-at-a-time",
            metadata: null,
            tags: ["telegram", "auto-session"],
            workflow: {
              status: "waiting",
            },
          },
        },
      ],
      onExhausted: "default",
    },
    "pi.session.turn": {
      results: [
        {
          data: {
            id: "session-for-default::openai::gpt-5-mini",
            agent: "default::openai::gpt-5-mini",
            status: "waiting",
            steeringMode: "one-at-a-time",
            workflow: {
              status: "waiting",
            },
            assistantText: "Pi says hello from the linked Telegram session.",
          },
        },
        {
          data: {
            id: "session-for-default::openai::gpt-5-mini",
            agent: "default::openai::gpt-5-mini",
            status: "waiting",
            steeringMode: "one-at-a-time",
            workflow: {
              status: "waiting",
            },
            assistantText: "Pi continues the original conversation.",
          },
        },
      ],
      onExhausted: "default",
    },
  },
  steps: [
    {
      id: "telegram-pi",
      event: {
        id: "event-telegram-pi-1",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:10:00.000Z",
        payload: {
          text: "/pi",
          chatId: "chat-1",
        },
        actor: {
          type: "external",
          externalId: "chat-1",
        },
      },
    },
    {
      id: "telegram-follow-up",
      event: {
        id: "event-telegram-pi-2",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:11:00.000Z",
        payload: {
          text: "Hello Pi",
          chatId: "chat-1",
        },
        actor: {
          type: "external",
          externalId: "chat-1",
        },
      },
    },
    {
      id: "telegram-follow-up-2",
      event: {
        id: "event-telegram-pi-3",
        orgId: "org-1",
        source: "telegram",
        eventType: "message.received",
        occurredAt: "2026-01-01T00:12:00.000Z",
        payload: {
          text: "And one more thing",
          chatId: "chat-1",
        },
        actor: {
          type: "external",
          externalId: "chat-1",
        },
      },
    },
  ],
  expectations: {
    replies: [
      "Created Pi session: session-for-default::openai::gpt-5-mini",
      "Pi says hello from the linked Telegram session.",
      "Pi continues the original conversation.",
    ],
    identityBindings: [
      {
        source: "telegram-pi-session",
        key: "user-1",
        value: "session-for-default::openai::gpt-5-mini",
      },
    ],
  },
} as const;

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
      id: "telegram-pi-session-ensure",
      source: AUTOMATION_SOURCES.telegram,
      eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
      enabled: true,
      script: {
        key: "telegram-pi-session.ensure",
        name: "Telegram Pi session ensure (linked chat)",
        engine: "bash",
        path: "scripts/telegram-pi-session.ensure.sh",
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
  [STARTER_AUTOMATION_SCRIPT_PATHS.telegramPiSessionEnsure]: starterTelegramPiSessionEnsureScript,
  [STARTER_AUTOMATION_SIMULATOR_PATHS.readme]: starterAutomationSimulatorReadme,
  [STARTER_AUTOMATION_SIMULATOR_PATHS.telegramClaimLinking]: `${JSON.stringify(STARTER_TELEGRAM_CLAIM_LINKING_SCENARIO, null, 2)}\n`,
  [STARTER_AUTOMATION_SIMULATOR_PATHS.telegramPiSession]: `${JSON.stringify(STARTER_TELEGRAM_PI_SESSION_SCENARIO, null, 2)}\n`,
} satisfies Record<string, FileSystemArtifact>;
