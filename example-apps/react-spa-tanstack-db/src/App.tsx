import { useState, useSyncExternalStore, type FormEvent } from "react";

import { eq, useLiveQuery } from "@tanstack/react-db";

import { DEMO_REFERENCE, SERVER_ORIGIN, type DemoRuntime } from "./runtime";

const shortOffset = (offset: string) =>
  offset === "-1" ? "beginning" : `${offset.slice(0, 7)}…${offset.slice(-6)}`;

const formatTime = (value: Date | undefined) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(value)
    : "pending";

function useStreamStatus(runtime: DemoRuntime) {
  return useSyncExternalStore(
    (listener) => runtime.streamDb.subscribeStatus(listener),
    () => runtime.streamDb.status,
  );
}

export default function App({ runtime }: { runtime: DemoRuntime }) {
  const status = useStreamStatus(runtime);
  const [author, setAuthor] = useState("Browser operator");
  const [message, setMessage] = useState("");
  const [writeState, setWriteState] = useState<
    | { state: "idle" }
    | { state: "writing"; operation: string }
    | { state: "error"; message: string }
  >({ state: "idle" });

  const { data: comments = [] } = useLiveQuery(
    (query) =>
      query
        .from({ comment: runtime.comments })
        .where(({ comment }) => eq(comment.postReference, DEMO_REFERENCE))
        .orderBy(({ comment }) => comment.createdAt, "desc"),
    [runtime.comments],
  );
  const { data: ratingRow } = useLiveQuery(
    (query) =>
      query
        .from({ total: runtime.upvoteTotals })
        .where(({ total }) => eq(total.reference, DEMO_REFERENCE))
        .findOne(),
    [runtime.upvoteTotals],
  );
  const rating = ratingRow?.total ?? 0;

  const performWrite = async (
    operation: string,
    request: () => Promise<Response>,
  ): Promise<boolean> => {
    setWriteState({ state: "writing", operation });
    try {
      const response = await request();
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}.`);
      }
      setWriteState({ state: "idle" });
      return true;
    } catch (error) {
      setWriteState({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const submitComment = async (event: FormEvent) => {
    event.preventDefault();
    const content = message.trim();
    if (!content) {
      return;
    }

    const published = await performWrite("Publishing comment", () =>
      fetch(`${SERVER_ORIGIN}/api/fragno-db-comment/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: content.slice(0, 48),
          content,
          postReference: DEMO_REFERENCE,
          userReference: author.trim() || "Anonymous operator",
        }),
      }),
    );
    if (published) {
      setMessage("");
    }
  };

  const submitRating = async (delta: number) => {
    await performWrite(delta > 0 ? "Adding signal" : "Removing signal", () =>
      fetch(`${SERVER_ORIGIN}/api/fragno-db-rating/upvotes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: DEMO_REFERENCE, rating: delta }),
      }),
    );
  };

  const reloadPersistedRuntime = async () => {
    await runtime.close();
    window.location.reload();
  };

  const statusLabel =
    status.status === "loading"
      ? "Catching up"
      : status.status === "ready"
        ? "Live"
        : status.status === "error"
          ? "Cached / offline"
          : status.status;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Fragno + TanStack DB</p>
          <h1>Durable notes</h1>
          <p className="lede">Notes persist locally and stay in sync with the server.</p>
        </div>
        <div className="status" data-status={status.status}>
          <span className="status-dot" />
          <div>
            <strong>{statusLabel}</strong>
            <code>{shortOffset(status.offset)}</code>
          </div>
        </div>
      </header>

      <div className="content-grid">
        <section className="card composer">
          <div className="section-heading">
            <h2>New note</h2>
            <p>Writes go through the Fragno server.</p>
          </div>

          <form onSubmit={submitComment}>
            <label>
              Name
              <input value={author} onChange={(event) => setAuthor(event.target.value)} />
            </label>
            <label>
              Note
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Write something…"
                rows={5}
              />
            </label>
            <button
              className="primary-button"
              type="submit"
              disabled={!message.trim() || writeState.state === "writing"}
            >
              {writeState.state === "writing" ? writeState.operation : "Add note"}
            </button>
          </form>

          <div className="rating-control">
            <span>Signal</span>
            <div className="rating-actions">
              <button
                type="button"
                onClick={() => void submitRating(-1)}
                aria-label="Decrease signal"
              >
                −
              </button>
              <strong>{rating >= 0 ? `+${rating}` : rating}</strong>
              <button
                type="button"
                onClick={() => void submitRating(1)}
                aria-label="Increase signal"
              >
                +
              </button>
            </div>
          </div>

          {writeState.state === "error" ? (
            <p className="error-note">Write failed: {writeState.message}</p>
          ) : null}
        </section>

        <section className="card notes-card">
          <div className="section-heading notes-heading">
            <div>
              <h2>Notes</h2>
              <p>Loaded from the local persisted collection.</p>
            </div>
            <span className="count">{comments.length}</span>
          </div>

          <div className="notes">
            {comments.length === 0 ? (
              <div className="empty-note">
                <p>No notes yet.</p>
                <span>Add one, then reload to test persistence.</span>
              </div>
            ) : (
              comments.map((comment) => (
                <article className="note" key={comment.id}>
                  <div className="note-meta">
                    <strong>{comment.userReference}</strong>
                    <time>{formatTime(comment.createdAt)}</time>
                  </div>
                  <p>{comment.content}</p>
                </article>
              ))
            )}
          </div>
        </section>
      </div>

      <footer className="persistence-bar">
        <div>
          <strong>Browser persistence enabled</strong>
          <span>SQLite WASM · OPFS · 3 collections</span>
        </div>
        <button type="button" onClick={() => void reloadPersistedRuntime()}>
          Reload to verify
        </button>
      </footer>

      {status.status === "error" ? (
        <div className="offline-note">
          <strong>Upstream unavailable.</strong> Cached notes remain readable.{" "}
          {status.error.message}
        </div>
      ) : null}

      <p className="endpoint">
        Server: <code>{SERVER_ORIGIN}</code>
      </p>
    </main>
  );
}
