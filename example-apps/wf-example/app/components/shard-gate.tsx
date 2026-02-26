import { useEffect, useState, type ReactNode } from "react";

import { getStoredShard, setStoredShard } from "~/sharding";

const suggestedShards = ["alpha", "beta", "gamma"];

type ShardGateProps = {
  children: ReactNode;
};

export function ShardGate({ children }: ShardGateProps) {
  const [ready, setReady] = useState(false);
  const [activeShard, setActiveShard] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = getStoredShard();
    setActiveShard(stored);
    setInputValue(stored ?? "");
    setReady(true);
  }, []);

  const handleSelect = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setError("Shard name cannot be empty.");
      return;
    }

    setStoredShard(trimmed);
    setActiveShard(trimmed);
    setError(null);
  };

  if (!ready || !activeShard) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6 py-16">
        <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white/95 p-8 shadow-xl shadow-slate-200/60">
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-slate-400">
            Sharding
          </p>
          <h1 className="mt-4 text-3xl font-semibold text-slate-900">Pick your workflow shard</h1>
          <p className="mt-3 text-sm text-slate-600">
            This demo uses row-level sharding. Choose the shard you want to explore before the app
            loads.
          </p>

          <form
            className="mt-6 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              handleSelect(inputValue);
            }}
          >
            <label className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
              Shard name
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                className="flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none"
                placeholder="team-alpha"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
              />
              <button
                className="rounded-2xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                type="submit"
              >
                Continue
              </button>
            </div>
            {error ? <p className="text-xs text-red-600">{error}</p> : null}
          </form>

          <div className="mt-6">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
              Suggested shards
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {suggestedShards.map((shard) => (
                <button
                  key={shard}
                  type="button"
                  onClick={() => handleSelect(shard)}
                  className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400"
                >
                  {shard}
                </button>
              ))}
            </div>
          </div>

          <p className="mt-6 text-xs text-slate-500">
            Your selection is stored in localStorage and sent as the
            <span className="font-mono"> x-fragno-shard</span> header on API calls.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
