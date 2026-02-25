import { useEffect, useState } from "react";
import { NavLink } from "react-router";

import { clearStoredShard, getStoredShard } from "~/sharding";

const navItems = [
  { to: "/", label: "Home" },
  { to: "/instances", label: "Instances" },
  { to: "/create-instance", label: "Create instance" },
];

export function TopNav() {
  const [activeShard, setActiveShard] = useState<string | null>(null);

  useEffect(() => {
    setActiveShard(getStoredShard());
  }, []);

  const handleSwitchShard = () => {
    clearStoredShard();
    window.location.assign("/");
  };

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="flex w-full items-center justify-between px-6 py-4 lg:px-10">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-xs font-semibold uppercase tracking-[0.2em] text-white">
            wf
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">
              Fragno
            </p>
            <p className="text-sm font-semibold text-slate-900">Workflow Fragment</p>
          </div>
        </div>
        <nav className="flex items-center gap-3 text-sm font-semibold text-slate-600">
          <div className="hidden items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 md:flex">
            <span className="text-slate-400">Shard</span>
            <span className="font-mono text-slate-900">{activeShard ?? "—"}</span>
          </div>
          <button
            type="button"
            onClick={handleSwitchShard}
            className="hidden rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 transition hover:border-slate-400 md:flex"
          >
            Switch shard
          </button>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `rounded-full px-4 py-2 transition ${
                  isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
