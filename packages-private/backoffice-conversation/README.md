# Backoffice conversation

A Backoffice agent's conversation as a chat reads it, without the components that show it. What
Backoffice writes into a conversation is public, in
`@fragno-dev/backoffice-api/v0/pi-conversation/*`; these modules build a chat's state from it, with
React and assistant-ui.

- `projection/`: the conversation as chat messages. `assistant-runtime` turns Pi's
  `ConversationView` into assistant-ui messages: turns with their tool calls, notifications,
  compactions, and the queue; `usePiPendingMessages` keeps prompts the agent has not picked up yet.
- `live/`: `usePiAgentViewSocket` follows an agent's `pi.agent.watch` socket. It asks for the
  socket's URL on every connection, so an app passes a function that fetches a new
  `pi.agent.watchTicket` each time; Backoffice passes its agent page's own `view-socket` route.
