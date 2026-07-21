import type { ReactNode, SyntheticEvent } from "react";
import { useEffect, useState } from "react";

import { coalesce, eq, useLiveQuery } from "@tanstack/react-db";

import type { LocalDatabase } from "./database";

type AppProps = {
  database: LocalDatabase;
};

type RequestState =
  | { state: "idle" }
  | { state: "pending"; message: string }
  | { state: "success"; message: string }
  | { state: "error"; message: string };

export default function App({ database }: AppProps) {
  const {
    comments: commentCollection,
    upvotes: upvoteCollection,
    ratingTotals: ratingTotalCollection,
  } = database.collections;
  const online = useOnlineStatus();
  const [mutationState, setMutationState] = useState<RequestState>({ state: "idle" });

  const commentFeedQuery = useLiveQuery(
    (query) =>
      query
        .from({ comment: commentCollection })
        .leftJoin({ total: ratingTotalCollection }, ({ comment, total }) =>
          eq(comment.postReference, total.reference),
        )
        .select(({ comment, total }) => ({
          id: comment.id,
          title: comment.title,
          content: comment.content,
          createdAt: comment.createdAt,
          postReference: comment.postReference,
          userReference: comment.userReference,
          ratingTotal: coalesce(total?.total, 0),
        }))
        .orderBy(({ $selected }) => $selected.createdAt, "desc"),
    [],
  );

  const recentVotesQuery = useLiveQuery(
    (query) =>
      query
        .from({ upvote: upvoteCollection })
        .orderBy(({ upvote: vote }) => vote.createdAt, "desc")
        .limit(8),
    [],
  );

  const totalsQuery = useLiveQuery(
    (query) =>
      query.from({ total: ratingTotalCollection }).orderBy(({ total }) => total.total, "desc"),
    [],
  );

  const submitComment = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void commitComment(form, data);
  };

  const commitComment = async (form: HTMLFormElement, data: FormData) => {
    setMutationState({ state: "pending", message: "Writing comment on the server…" });
    try {
      await postJson(database.endpoints.comments, {
        title: requiredFormValue(data, "title"),
        content: requiredFormValue(data, "content"),
        postReference: requiredFormValue(data, "postReference"),
        userReference: requiredFormValue(data, "userReference"),
      });
      form.reset();
      setMutationState({
        state: "success",
        message: "Comment committed. The outbox will materialize it locally.",
      });
    } catch (error) {
      setMutationState({ state: "error", message: formatError(error) });
    }
  };

  const submitRating = async (reference: string, rating: number) => {
    setMutationState({
      state: "pending",
      message: `${rating > 0 ? "Adding" : "Removing"} a point on ${reference}…`,
    });
    try {
      await postJson(database.endpoints.ratings, { reference, rating });
      setMutationState({
        state: "success",
        message: "Rating committed. The outbox will update the local collections.",
      });
    } catch (error) {
      setMutationState({ state: "error", message: formatError(error) });
    }
  };

  const checkpoints = database.getCheckpoints();
  const commentRows = commentFeedQuery.data ?? [];
  const recentVotes = recentVotesQuery.data ?? [];
  const loading = commentFeedQuery.isLoading || recentVotesQuery.isLoading || totalsQuery.isLoading;
  const hasQueryError = commentFeedQuery.isError || recentVotesQuery.isError || totalsQuery.isError;
  const busy = mutationState.state === "pending";

  return (
    <div className="app-shell">
      <header className="masthead reveal reveal--one">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            F×T
          </span>
          <div>
            <p className="eyebrow">Fragno durable outbox / TanStack DB</p>
            <h1>Local field notes</h1>
          </div>
        </div>
        <div className="connection" data-online={online}>
          <span className="connection__dot" />
          <span>{online ? "Server reachable" : "Reading local SQLite"}</span>
        </div>
      </header>

      <main>
        <section className="intro reveal reveal--two">
          <p className="kicker">Durable local data</p>
          <h2>Server writes. Local reads stay live.</h2>
        </section>

        <section className="control-strip reveal reveal--three">
          <div>
            <span className="control-strip__label">Server origin</span>
            <code>{database.endpoints.serverOrigin}</code>
          </div>
          <div>
            <span className="control-strip__label">Comment checkpoint</span>
            <Checkpoint value={checkpoints.comments?.versionstamp} />
          </div>
          <div>
            <span className="control-strip__label">Rating checkpoint</span>
            <Checkpoint value={checkpoints.ratings?.versionstamp} />
          </div>
        </section>

        <StatusMessage state={mutationState} />
        {hasQueryError ? (
          <div className="notice notice--error">A local live query entered an error state.</div>
        ) : null}

        <div className="workspace reveal reveal--four">
          <section className="feed-panel">
            <div className="section-heading">
              <div>
                <p className="kicker">Live joined query</p>
                <h2>Comment stream</h2>
              </div>
              <span className="count-badge">{commentRows.length}</span>
            </div>

            {loading && commentRows.length === 0 ? (
              <EmptyState>Hydrating the local collections…</EmptyState>
            ) : commentRows.length === 0 ? (
              <EmptyState>
                No comments are materialized yet. Add one here or use the database example CLI.
              </EmptyState>
            ) : (
              <div className="comment-list">
                {commentRows.map((comment) => (
                  <article className="comment-card" key={comment.id}>
                    <div className="comment-card__meta">
                      <code>{comment.postReference}</code>
                      <time>{formatDate(comment.createdAt)}</time>
                    </div>
                    <h3>{comment.title}</h3>
                    <p>{comment.content}</p>
                    <footer>
                      <span className="author">by {comment.userReference}</span>
                      <div className="rating-controls" aria-label={`Rate ${comment.postReference}`}>
                        <button
                          type="button"
                          onClick={() => void submitRating(comment.postReference, -1)}
                          disabled={busy || !online}
                          aria-label="Downvote"
                        >
                          −
                        </button>
                        <strong>{comment.ratingTotal}</strong>
                        <button
                          type="button"
                          onClick={() => void submitRating(comment.postReference, 1)}
                          disabled={busy || !online}
                          aria-label="Upvote"
                        >
                          +
                        </button>
                      </div>
                    </footer>
                  </article>
                ))}
              </div>
            )}
          </section>

          <aside className="side-column">
            <section className="composer panel-block">
              <div className="section-heading section-heading--compact">
                <div>
                  <p className="kicker">Server mutation</p>
                  <h2>Add a note</h2>
                </div>
              </div>
              <form onSubmit={submitComment}>
                <label>
                  Post reference
                  <input name="postReference" defaultValue="post-1" required />
                </label>
                <label>
                  User reference
                  <input name="userReference" defaultValue="user-1" required />
                </label>
                <label>
                  Title
                  <input name="title" placeholder="A useful observation" required />
                </label>
                <label>
                  Comment
                  <textarea
                    name="content"
                    rows={5}
                    placeholder="Write to the server; read it back from the outbox."
                    required
                  />
                </label>
                <button className="button button--signal" type="submit" disabled={busy || !online}>
                  {mutationState.state === "pending" ? "Committing…" : "Commit comment"}
                </button>
                {!online ? (
                  <p className="form-note">
                    Writes pause offline; persisted reads remain available.
                  </p>
                ) : null}
              </form>
            </section>

            <section className="activity panel-block">
              <div className="section-heading section-heading--compact">
                <div>
                  <p className="kicker">upvote.upvote</p>
                  <h2>Recent rating events</h2>
                </div>
              </div>
              {recentVotes.length === 0 ? (
                <EmptyState>No rating events yet.</EmptyState>
              ) : (
                <ol className="activity-list">
                  {recentVotes.map((vote) => (
                    <li key={vote.id}>
                      <span className={vote.rating >= 0 ? "vote vote--up" : "vote vote--down"}>
                        {vote.rating > 0 ? `+${vote.rating}` : vote.rating}
                      </span>
                      <div>
                        <code>{vote.reference}</code>
                        <time>{formatDate(vote.createdAt)}</time>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </aside>
        </div>
      </main>

      <footer className="page-footer reveal reveal--five">
        <span>
          SQLite rows and outbox checkpoints persist in the same TanStack sync transaction.
        </span>
        <span>Polling every second</span>
      </footer>
    </div>
  );
}

function Checkpoint({ value }: { value?: string }) {
  return <code className="checkpoint">{value ? value.slice(-12) : "not synced"}</code>;
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

function StatusMessage({ state }: { state: RequestState }) {
  if (state.state === "idle") {
    return null;
  }

  return (
    <div className={`notice notice--${state.state}`} role="status" aria-live="polite">
      {state.message}
    </div>
  );
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const markOnline = () => {
      setOnline(true);
    };
    const markOffline = () => {
      setOnline(false);
    };
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  return online;
}

async function postJson(url: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.ok) {
    return;
  }

  const detail = await response.text();
  throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
}

function requiredFormValue(data: FormData, name: string): string {
  const value = data.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function formatDate(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return String(value);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
