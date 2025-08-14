import type { Route } from "./+types/home";
import { WelcomeShell, WelcomeHero, WelcomeExperiments } from "../welcome/welcome";
import { createChatnoClient } from "@rejot-dev/chatno";
import { useFragno } from "@rejot-dev/fragno/client/react";
import { useState } from "react";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Fragno • Experimental" },
    { name: "description", content: "A beautiful experimental page for the Fragno library." },
  ];
}

const chatnoClient = createChatnoClient({});
const { useEcho, useAiConfig, useThing } = useFragno(chatnoClient);

export default function Home() {
  // State for reading messages
  const [messageKey, setMessageKey] = useState("default");
  const [capital, setCapital] = useState(false);

  // State for writing messages
  const [newMessageKey, setNewMessageKey] = useState("default");
  const [newMessage, setNewMessage] = useState("Hello World");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);

  const { data: echoData, loading: echoLoading } = useEcho({
    pathParams: {
      message: messageKey,
    },
    queryParams: {
      capital: String(capital),
    },
  });
  const { data: aiConfig, loading: aiConfigLoading } = useAiConfig();
  const { data: thing } = useThing({
    pathParams: {
      path: "hello",
    },
  });

  // const echoMutator = useEchoMutator;
  // console.log({
  //   echoMutator,
  // })
  // const { mutate, loading, error } = useEchoMutator();
  // console.log({
  //   mutator,
  // });

  const handleSubmitMessage = async () => {
    if (!newMessage.trim() || !newMessageKey.trim()) return;

    setIsSubmitting(true);
    setSubmitResult(null);

    try {
      // const result = await echoMutator(
      //   { message: newMessage },
      //   {
      //     pathParams: {
      //       messageKey: newMessageKey,
      //     },
      //   },
      // );
      const result = {
        messageKey: newMessageKey,
        previous: "none",
        message: newMessage,
      };
      setSubmitResult(`Message saved! Previous: "${result.previous || "none"}"`);
      // Update the read section to show the newly created/updated message
      setMessageKey(newMessageKey);
    } catch (error) {
      setSubmitResult(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <WelcomeShell>
      <WelcomeHero />

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <h2 className="mb-6 text-xl font-semibold">Message Management</h2>

        {/* Write Messages Section */}
        <div className="mb-8 rounded-2xl border border-gray-200 bg-white/60 p-6 dark:border-gray-800 dark:bg-gray-900/60">
          <h3 className="mb-4 text-lg font-medium text-gray-900 dark:text-gray-100">
            Write/Update Messages
          </h3>

          <div className="mb-4">
            <label
              htmlFor="new-message-key"
              className="mb-2 block text-sm font-medium text-gray-900 dark:text-gray-100"
            >
              Message Key
            </label>
            <input
              id="new-message-key"
              type="text"
              value={newMessageKey}
              onChange={(e) => setNewMessageKey(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              placeholder="Enter a key for the message..."
            />
          </div>

          <div className="mb-4">
            <label
              htmlFor="new-message"
              className="mb-2 block text-sm font-medium text-gray-900 dark:text-gray-100"
            >
              Message Content
            </label>
            <input
              id="new-message"
              type="text"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              placeholder="Enter the message content..."
            />
          </div>

          <button
            onClick={handleSubmitMessage}
            disabled={isSubmitting || !newMessage.trim() || !newMessageKey.trim()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:ring-2 focus:ring-blue-500/20 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
          >
            {isSubmitting ? "Saving..." : "Save Message"}
          </button>

          {submitResult && (
            <div className="mt-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-950">
              <p className="text-sm text-gray-700 dark:text-gray-300">{submitResult}</p>
            </div>
          )}
        </div>

        {/* Read Messages Section */}
        <div className="mb-8 rounded-2xl border border-gray-200 bg-white/60 p-6 dark:border-gray-800 dark:bg-gray-900/60">
          <h3 className="mb-4 text-lg font-medium text-gray-900 dark:text-gray-100">
            Read Messages
          </h3>

          <div className="mb-4">
            <label
              htmlFor="message-key-input"
              className="mb-2 block text-sm font-medium text-gray-900 dark:text-gray-100"
            >
              Message Key to Read
            </label>
            <input
              id="message-key-input"
              type="text"
              value={messageKey}
              onChange={(e) => setMessageKey(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              placeholder="Enter a message key to read..."
            />
            <div className="mt-2 flex items-center gap-2">
              <input
                id="capital-toggle"
                type="checkbox"
                checked={capital}
                onChange={(e) => setCapital(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900"
              />
              <label htmlFor="capital-toggle" className="text-sm text-gray-700 dark:text-gray-300">
                Capitalize
              </label>
            </div>
          </div>

          <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-950">
            <h4 className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">
              Message Content:
            </h4>
            {echoLoading ? (
              <p className="text-sm text-gray-600 dark:text-gray-300">Loading…</p>
            ) : (
              <p className="text-sm text-gray-700 dark:text-gray-200">
                {echoData === undefined ? "—" : String(echoData)}
              </p>
            )}
          </div>
        </div>

        <h2 className="mb-4 text-xl font-semibold">Other Live Data</h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-gray-200 bg-white/60 p-4 dark:border-gray-800 dark:bg-gray-900/60">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">AI Config</h3>
            <div className="mt-2">
              {aiConfigLoading ? (
                <p className="text-sm text-gray-600 dark:text-gray-300">Loading…</p>
              ) : (
                <pre className="max-h-60 overflow-auto rounded bg-gray-50 p-3 text-xs dark:bg-gray-950">
                  {JSON.stringify(aiConfig, null, 2)}
                </pre>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white/60 p-4 dark:border-gray-800 dark:bg-gray-900/60">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Thing</h3>
            <pre className="mt-2 max-h-60 overflow-auto rounded bg-gray-50 p-3 text-xs dark:bg-gray-950">
              {JSON.stringify(thing, null, 2)}
            </pre>
          </div>
        </div>
      </section>

      <WelcomeExperiments />
    </WelcomeShell>
  );
}
