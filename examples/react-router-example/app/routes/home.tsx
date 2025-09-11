import type { Route } from "./+types/home";
import { WelcomeShell, WelcomeHero, WelcomeExperiments } from "../welcome/welcome";
import { createChatnoClient } from "@fragno-dev/chatno";
import { useFragno } from "@fragno-dev/core/react";
import { useState } from "react";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Fragno • Experimental" },
    { name: "description", content: "A beautiful experimental page for the Fragno library." },
  ];
}

const chatnoClient = createChatnoClient();
const { useChat, useHealth } = useFragno(chatnoClient);

export default function Home() {
  const { mutate: submitMessageToAI, data: aiResponse, loading: aiResponseLoading } = useChat();
  const { data: healthData, loading: healthLoading } = useHealth();
  const [message, setMessage] = useState("");

  const handleSubmitMessage = async () => {
    if (!message.trim()) return;

    try {
      await submitMessageToAI({
        body: {
          messages: [{ type: "chat", id: crypto.randomUUID(), role: "user", content: message }],
        },
      });
      setMessage(""); // Clear the input after sending
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  return (
    <WelcomeShell>
      <WelcomeHero />

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <div className="space-y-6 rounded-lg bg-white p-6 shadow-lg">
          <h2 className="text-2xl font-bold text-gray-900">
            Chat with AI {healthLoading ? " (...)" : ` (${healthData?.status})`}
          </h2>

          {/* Response Display */}
          {aiResponse && (
            <div className="rounded-lg bg-gray-50 p-4">
              <h3 className="mb-2 text-sm font-semibold text-gray-700">AI Response:</h3>
              <div className="whitespace-pre-wrap text-gray-900">
                {JSON.stringify(aiResponse, null, 2)}
              </div>
            </div>
          )}

          {/* Loading State */}
          {aiResponseLoading && (
            <div className="rounded-lg bg-blue-50 p-4">
              <div className="flex items-center space-x-2">
                <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-blue-600"></div>
                <span className="text-blue-700">AI is thinking...</span>
              </div>
            </div>
          )}

          {/* Message Input */}
          <div className="space-y-4">
            <div>
              <label htmlFor="message" className="mb-2 block text-sm font-medium text-gray-700">
                Your Message
              </label>
              <textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Type your message here... (Press Enter to send, Shift+Enter for new line)"
                className="w-full resize-none rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                rows={4}
                disabled={aiResponseLoading}
              />
            </div>

            <button
              onClick={handleSubmitMessage}
              disabled={!message.trim()}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {aiResponseLoading ? "Sending..." : "Send Message"}
            </button>
          </div>
        </div>
      </section>

      <WelcomeExperiments />
    </WelcomeShell>
  );
}
