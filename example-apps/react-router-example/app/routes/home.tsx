import type { Route } from "./+types/home";
import { WelcomeShell, WelcomeHero, WelcomeExperiments } from "../welcome/welcome";
import { createChatnoClient } from "@fragno-dev/chatno/react";
import { createCommentFragmentClient } from "@fragno-dev/fragno-db-library";
import { useState } from "react";
import { createChatno } from "~/chatno/chatno.server";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Fragno • Experimental" },
    { name: "description", content: "A beautiful experimental page for the Fragno library." },
  ];
}

export function loader() {
  return {
    openaiURL: createChatno().services.getOpenAIURL(),
  };
}

const { useSendMessage } = createChatnoClient();
const { useGetComments, useCreateComment } = createCommentFragmentClient();

export default function Home({ loaderData }: Route.ComponentProps) {
  const { openaiURL } = loaderData;
  console.log({ openaiURL });

  const { response, responseLoading, sendMessage } = useSendMessage();
  const [message, setMessage] = useState("");

  // Comments state
  const [commentTitle, setCommentTitle] = useState("");
  const [commentContent, setCommentContent] = useState("");
  const comments = useGetComments({ query: { postReference: "demo-post" } });
  const { mutate: createComment, loading: creatingComment } = useCreateComment();

  const handleSubmitMessage = async () => {
    if (!message.trim()) {
      return;
    }

    try {
      await sendMessage(message);
      setMessage(""); // Clear the input after sending
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const handleCreateComment = async () => {
    if (!commentTitle.trim() || !commentContent.trim()) {
      return;
    }

    try {
      await createComment({
        body: {
          title: commentTitle,
          content: commentContent,
          postReference: "demo-post",
          userReference: "demo-user",
        },
      });
      setCommentTitle("");
      setCommentContent("");
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  return (
    <WelcomeShell>
      <WelcomeHero />

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <div className="space-y-6 rounded-lg bg-white p-6 shadow-lg dark:bg-gray-900 dark:shadow-gray-800/20">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Message</h2>

          {/* Response Display */}
          {response && (
            <div className="rounded-lg bg-gray-50 p-4 dark:bg-gray-800">
              <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                AI Response:
              </h3>
              <div className="whitespace-pre-wrap text-gray-900 dark:text-gray-100">{response}</div>
            </div>
          )}

          {/* Loading State */}
          {responseLoading && (
            <div className="rounded-lg bg-blue-50 p-4 dark:bg-blue-950/50">
              <div className="flex items-center space-x-2">
                <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-blue-600 dark:border-blue-400"></div>
                <span className="text-blue-700 dark:text-blue-300">AI is thinking...</span>
              </div>
            </div>
          )}

          {/* Message Input */}
          <div className="space-y-4">
            <div>
              <label
                htmlFor="message"
                className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Your Message
              </label>
              <textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Type your message here..."
                className="w-full resize-none rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400 dark:focus:border-blue-400 dark:focus:ring-blue-400"
                rows={4}
                disabled={responseLoading}
              />
            </div>

            <button
              onClick={handleSubmitMessage}
              disabled={!message.trim()}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus:ring-offset-gray-900"
            >
              {responseLoading ? "Sending..." : "Send Message"}
            </button>
          </div>
        </div>
      </section>

      {/* Comments Section */}
      <section className="mx-auto max-w-5xl px-6 pb-16">
        <div className="space-y-6 rounded-lg bg-white p-6 shadow-lg dark:bg-gray-900 dark:shadow-gray-800/20">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Comments Demo</h2>

          {/* Create Comment Form */}
          <div className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-200">
              Add a Comment
            </h3>
            <div>
              <label
                htmlFor="comment-title"
                className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Title
              </label>
              <input
                id="comment-title"
                type="text"
                value={commentTitle}
                onChange={(e) => setCommentTitle(e.target.value)}
                placeholder="Comment title..."
                className="w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400"
                disabled={creatingComment}
              />
            </div>
            <div>
              <label
                htmlFor="comment-content"
                className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Content
              </label>
              <textarea
                id="comment-content"
                value={commentContent}
                onChange={(e) => setCommentContent(e.target.value)}
                placeholder="Comment content..."
                className="w-full resize-none rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400"
                rows={3}
                disabled={creatingComment}
              />
            </div>
            <button
              onClick={handleCreateComment}
              disabled={!commentTitle.trim() || !commentContent.trim() || creatingComment}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus:ring-offset-gray-900"
            >
              {creatingComment ? "Creating..." : "Create Comment"}
            </button>
          </div>

          {/* Comments List */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-200">
              Comments {comments.data && `(${comments.data.length})`}
            </h3>

            {comments.loading && (
              <div className="rounded-lg bg-blue-50 p-4 dark:bg-blue-950/50">
                <div className="flex items-center space-x-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-blue-600 dark:border-blue-400"></div>
                  <span className="text-blue-700 dark:text-blue-300">Loading comments...</span>
                </div>
              </div>
            )}

            {comments.error && (
              <div className="rounded-lg bg-red-50 p-4 dark:bg-red-950/50">
                <p className="text-red-700 dark:text-red-300">
                  Error loading comments: {comments.error.message}
                </p>
              </div>
            )}

            {comments.data && comments.data.length === 0 && (
              <p className="text-gray-600 dark:text-gray-400">
                No comments yet. Be the first to add one!
              </p>
            )}

            {comments.data && comments.data.length > 0 && (
              <div className="space-y-3">
                {comments.data.map((comment) => (
                  <div
                    key={comment.id}
                    className="rounded-lg border border-gray-200 p-4 dark:border-gray-700"
                  >
                    <h4 className="font-semibold text-gray-900 dark:text-gray-100">
                      {comment.title}
                    </h4>
                    <p className="mt-2 text-gray-700 dark:text-gray-300">{comment.content}</p>
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      Rating: {comment.rating}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <WelcomeExperiments />
    </WelcomeShell>
  );
}
