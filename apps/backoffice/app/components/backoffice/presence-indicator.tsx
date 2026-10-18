import { PresenceStack } from "@fragno-private/design-system/presence-stack";
import { useEffect } from "react";
import { useFetcher } from "react-router";

import type { PresenceMember } from "@/presence/contracts";
import type { loader as presenceLoader } from "@/routes/backoffice/presence";

import { userDisplayName, userInitials } from "./user-display";

const REFRESH_INTERVAL_MS = 30_000;

function describeActivity(member: PresenceMember, nowEpochMs: number) {
  // Paths read /backoffice/<section>/…; the section is enough to say where someone is.
  const section = member.path?.split("/")[2];
  const where = section ? section.slice(0, 1).toUpperCase() + section.slice(1) : "Elsewhere";
  const minutes = Math.floor((nowEpochMs - Date.parse(member.lastActiveAt)) / 60_000);
  return `${where} · ${minutes < 1 ? "now" : `${minutes}m ago`}`;
}

/** The other members of the active organization who were recently active in Backoffice. */
export function BackofficePresenceIndicator() {
  const fetcher = useFetcher<typeof presenceLoader>();
  const { load } = fetcher;

  useEffect(
    function refreshWhileVisible() {
      function refresh() {
        if (document.visibilityState === "visible") {
          void load("/backoffice/presence");
        }
      }
      refresh();
      const interval = window.setInterval(refresh, REFRESH_INTERVAL_MS);
      document.addEventListener("visibilitychange", refresh);
      return () => {
        window.clearInterval(interval);
        document.removeEventListener("visibilitychange", refresh);
      };
    },
    [load],
  );

  const nowEpochMs = Date.now();
  const people = (fetcher.data?.members ?? []).map((member) => ({
    id: member.userId,
    initials: userInitials(member.email),
    name: userDisplayName(member.email),
    email: member.email,
    activity: describeActivity(member, nowEpochMs),
  }));
  if (people.length === 0) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center px-4 min-[960px]:border-l min-[960px]:border-[color:var(--bo-border)]">
      <PresenceStack people={people} />
    </div>
  );
}
