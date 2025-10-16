import { createChatnoClient } from "@fragno-dev/chatno/solid";

import { createSignal, Show } from "solid-js";

export function Chat() {
  const { useSendMessage } = createChatnoClient();
  const [message, setMessage] = createSignal("");

  const { response, responseLoading, sendMessage } = useSendMessage();

  const handleSubmitMessage = async () => {
    if (!message().trim()) return;

    try {
      sendMessage(message());
      setMessage(""); // Clear the input after sending
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  return (
    <div class="space-y-6 rounded-lg bg-white p-6 shadow">
      <h2 class="text-xl font-semibold text-gray-800">Chat with AI</h2>

      <Show when={response()}>
        <div class="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <p class="mb-2 text-xs font-medium uppercase tracking-wide text-gray-600">Response</p>
          <div class="whitespace-pre-wrap text-gray-900">{response()}</div>
        </div>
      </Show>

      <Show when={responseLoading()}>
        <div class="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <div class="flex items-center gap-2">
            <div class="h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            <span class="text-sm text-blue-700">Thinking...</span>
          </div>
        </div>
      </Show>

      <div class="space-y-3">
        <label for="message" class="block text-sm font-medium text-gray-700">
          Your Message
        </label>
        <textarea
          id="message"
          value={message()}
          onInput={(e) => setMessage(e.currentTarget.value)}
          placeholder="Type your message here..."
          class="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          rows={4}
          disabled={responseLoading()}
        />
        <button
          onClick={handleSubmitMessage}
          disabled={!message().trim() || responseLoading()}
          class="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Show when={responseLoading()} fallback="Send Message">
            Sending...
          </Show>
        </button>
      </div>
    </div>
  );
}
