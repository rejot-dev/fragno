import { days, hours, minutes, storyScope, withoutRows, type StoryRow } from "./story-scope";

/**
 * The events an hourly bank sync emits, shaped as the bank pages read them: each record is an
 * entity whose newer versions replace older ones, and the first sync imports the existing history
 * as backfill. The production Brex page and the bank-accounts example read the same data under
 * different names, so scopes take the names their page reads. Records hold both the values the
 * example reads, such as amountCents, and the display text the production page reads.
 */

const ACCOUNTS = {
  operating: { name: "Operating", currency: "USD", lastFour: "4821" },
  treasury: { name: "Treasury", currency: "USD", lastFour: "9034" },
  eu: { name: "EU operations", currency: "EUR", lastFour: "2210" },
} as const;

type AccountId = keyof typeof ACCOUNTS;

const ACCOUNT_STATUSES = {
  PROCESSED: ["Completed", "live"],
  PENDING: ["Pending", "waiting"],
  SCHEDULED: ["Scheduled", "waiting"],
  FAILED: ["Failed", "failed"],
} as const;

const CARD_STATUSES = {
  POSTED: ["Posted", "live"],
  PENDING: ["Pending", "waiting"],
  DECLINED: ["Declined", "failed"],
} as const;

const CARDS = {
  engineering: { card: "Engineering ••7712", owner: "Maya Chen" },
  marketing: { card: "Marketing ••3390", owner: "Jonas Weber" },
} as const;

/** When the first sync imported the history before it. */
const IMPORTED_AT = days(9);

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    signDisplay: "exceptZero",
  }).format(amount);
}

let eventCount = 0;

/** An event the sync emitted for version `version` of an entity; scopes set its source. */
function emitted(
  eventType: string,
  entityId: string,
  version: number,
  record: StoryRow,
  occurredAt: Date,
): StoryRow {
  eventCount += 1;
  return {
    id: `bank-event-${eventCount}`,
    eventType,
    occurredAt,
    payload: {
      eventKey: `${eventType}:${entityId}:${version}`,
      entityId,
      version,
      backfill: occurredAt.getTime() === IMPORTED_AT.getTime(),
      record,
    },
  };
}

type AccountTransaction = {
  id: string;
  accountId: AccountId;
  date: string;
  description: string;
  amount: number;
  from: string;
  to: string;
  /** Each status the transaction had, oldest first, with when the sync saw it. */
  versions: [status: keyof typeof ACCOUNT_STATUSES, seenAt: Date][];
};

function accountTransaction({
  id,
  accountId,
  date,
  description,
  amount,
  from,
  to,
  versions,
}: AccountTransaction): StoryRow[] {
  const { currency } = ACCOUNTS[accountId];
  return versions.map(([status, seenAt], index) =>
    emitted(
      index === 0 ? "transaction.created" : "transaction.updated",
      id,
      index + 1,
      {
        kind: "account",
        accountId,
        date,
        description,
        amount: amount.toFixed(2),
        amountCents: Math.round(amount * 100),
        currency,
        displayAmount: money(amount, currency),
        status,
        statusLabel: ACCOUNT_STATUSES[status][0],
        tone: ACCOUNT_STATUSES[status][1],
        source: from,
        target: to,
      },
      seenAt,
    ),
  );
}

type CardTransaction = {
  id: string;
  card: keyof typeof CARDS;
  date: string;
  description: string;
  amount: number;
  versions: [status: keyof typeof CARD_STATUSES, seenAt: Date][];
};

function cardTransaction({
  id,
  card,
  date,
  description,
  amount,
  versions,
}: CardTransaction): StoryRow[] {
  return versions.map(([status, seenAt], index) =>
    emitted(
      index === 0 ? "transaction.created" : "transaction.updated",
      id,
      index + 1,
      {
        kind: "card",
        accountId: "card-account",
        date,
        description,
        amount: amount.toFixed(2),
        amountCents: Math.round(amount * 100),
        currency: "USD",
        displayAmount: money(amount, "USD"),
        status,
        statusLabel: CARD_STATUSES[status][0],
        tone: CARD_STATUSES[status][1],
        ...CARDS[card],
      },
      seenAt,
    ),
  );
}

/** Each balance the account had, oldest first, with when the sync saw it. */
function balances(accountId: AccountId, versions: [cents: number, seenAt: Date][]): StoryRow[] {
  const account = ACCOUNTS[accountId];
  return versions.map(([cents, seenAt], index) =>
    emitted(
      "balance.updated",
      accountId,
      index + 1,
      {
        kind: "balance",
        ...account,
        balance: money(cents / 100, account.currency).replace(/^\+/u, ""),
        balanceCents: cents,
      },
      seenAt,
    ),
  );
}

const operating = `Operating ••${ACCOUNTS.operating.lastFour}`;
const treasury = `Treasury ••${ACCOUNTS.treasury.lastFour}`;
const eu = `EU operations ••${ACCOUNTS.eu.lastFour}`;

const events: StoryRow[] = [
  ...balances("operating", [
    [21_884_310, IMPORTED_AT],
    [24_119_480, hours(50)],
    [22_947_163, minutes(58)],
  ]),
  ...balances("treasury", [
    [125_061_233, IMPORTED_AT],
    [75_061_233, days(7)],
  ]),
  ...balances("eu", [
    [4_412_050, IMPORTED_AT],
    [3_992_050, hours(3)],
  ]),
  ...accountTransaction({
    id: "acct-tx-payroll-sep",
    accountId: "operating",
    date: "2026-09-28",
    description: "Gusto payroll",
    amount: -37_980.1,
    from: operating,
    to: "Gusto",
    versions: [["PROCESSED", IMPORTED_AT]],
  }),
  ...accountTransaction({
    id: "acct-tx-interest",
    accountId: "treasury",
    date: "2026-10-02",
    description: "Treasury interest",
    amount: 612.33,
    from: "Treasury yield",
    to: treasury,
    versions: [["PROCESSED", IMPORTED_AT]],
  }),
  ...accountTransaction({
    id: "acct-tx-card-repayment",
    accountId: "operating",
    date: "2026-10-05",
    description: "Card repayment",
    amount: -9_412.18,
    from: operating,
    to: "Company card",
    versions: [["PROCESSED", IMPORTED_AT]],
  }),
  ...accountTransaction({
    id: "acct-tx-northwind",
    accountId: "eu",
    date: "2026-10-09",
    description: "Northwind B.V. · invoice 2026-031",
    amount: 18_000,
    from: "Northwind B.V.",
    to: eu,
    versions: [["PROCESSED", IMPORTED_AT]],
  }),
  ...accountTransaction({
    id: "acct-tx-transfer-out",
    accountId: "treasury",
    date: "2026-10-15",
    description: "Transfer to Operating",
    amount: -50_000,
    from: treasury,
    to: operating,
    versions: [
      ["PENDING", days(7)],
      ["PROCESSED", days(6)],
    ],
  }),
  ...accountTransaction({
    id: "acct-tx-transfer-in",
    accountId: "operating",
    date: "2026-10-15",
    description: "Transfer from Treasury",
    amount: 50_000,
    from: treasury,
    to: operating,
    versions: [
      ["PENDING", days(7)],
      ["PROCESSED", days(6)],
    ],
  }),
  ...accountTransaction({
    id: "acct-tx-acme",
    accountId: "eu",
    date: "2026-10-18",
    description: "Wire to Acme GmbH",
    amount: -1_150,
    from: eu,
    to: "Acme GmbH",
    versions: [
      ["PENDING", days(4)],
      ["FAILED", days(3)],
    ],
  }),
  ...accountTransaction({
    id: "acct-tx-payroll-oct",
    accountId: "operating",
    date: "2026-10-20",
    description: "Gusto payroll",
    amount: -38_215.42,
    from: operating,
    to: "Gusto",
    versions: [
      ["PENDING", hours(52)],
      ["PROCESSED", hours(50)],
    ],
  }),
  ...accountTransaction({
    id: "acct-tx-stripe",
    accountId: "operating",
    date: "2026-10-21",
    description: "Stripe payout",
    amount: 12_480,
    from: "Stripe",
    to: operating,
    versions: [["PROCESSED", hours(20)]],
  }),
  ...accountTransaction({
    id: "acct-tx-contractor",
    accountId: "eu",
    date: "2026-10-22",
    description: "Contractor · Lena Fischer",
    amount: -4_200,
    from: eu,
    to: "Lena Fischer",
    versions: [["PENDING", hours(3)]],
  }),
  ...accountTransaction({
    id: "acct-tx-rent",
    accountId: "operating",
    date: "2026-10-25",
    description: "Office rent · WeWork",
    amount: -6_500,
    from: operating,
    to: "WeWork",
    versions: [["SCHEDULED", minutes(58)]],
  }),
  ...cardTransaction({
    id: "card-tx-cloudflare",
    card: "engineering",
    date: "2026-10-03",
    description: "Cloudflare",
    amount: -230,
    versions: [["POSTED", IMPORTED_AT]],
  }),
  ...cardTransaction({
    id: "card-tx-lufthansa",
    card: "marketing",
    date: "2026-10-08",
    description: "Lufthansa · FRA → SFO",
    amount: -812.6,
    versions: [["POSTED", IMPORTED_AT]],
  }),
  ...cardTransaction({
    id: "card-tx-figma",
    card: "marketing",
    date: "2026-10-17",
    description: "Figma",
    amount: -540,
    versions: [
      ["PENDING", days(5)],
      ["POSTED", days(4)],
    ],
  }),
  ...cardTransaction({
    id: "card-tx-github",
    card: "engineering",
    date: "2026-10-19",
    description: "GitHub",
    amount: -441,
    versions: [
      ["PENDING", days(3)],
      ["POSTED", hours(50)],
    ],
  }),
  ...cardTransaction({
    id: "card-tx-google-ads",
    card: "marketing",
    date: "2026-10-20",
    description: "Google Ads",
    amount: -1_200,
    versions: [["DECLINED", hours(49)]],
  }),
  ...cardTransaction({
    id: "card-tx-aws",
    card: "engineering",
    date: "2026-10-21",
    description: "Amazon Web Services",
    amount: -2_318.44,
    versions: [
      ["PENDING", hours(20)],
      ["POSTED", hours(3)],
    ],
  }),
  ...cardTransaction({
    id: "card-tx-linear",
    card: "engineering",
    date: "2026-10-22",
    description: "Linear",
    amount: -96,
    versions: [["PENDING", minutes(58)]],
  }),
];

/**
 * The names a bank page reads: its events' source, the sync's route, and how its runs are found.
 * A sync that starts a run per occurrence names its workflow; a sync that signals one long-lived
 * worker names the worker's instance and the store key where it records its health.
 */
type SyncNames = { source: string; routeId: string } & (
  | { workflowName: string }
  | { healthKey: string; workerInstanceId: string }
);

type RunStatus = "active" | "waiting" | "complete" | "errored";

/** A sync's scopes: synced since its import nine days ago, failing and paused, and first sync. */
export function bankScopes(names: SyncNames) {
  const { source, routeId } = names;
  const healthKey = "healthKey" in names ? names.healthKey : null;
  // A table without rows has no columns to create, so a sync without stored health leaves it out.
  const syncHealth = (at: Date): Record<string, StoryRow[]> =>
    healthKey
      ? {
          kv_store: [
            {
              id: `kv-${healthKey}`,
              key: healthKey,
              value: { at: at.getTime(), records: events.length, emitted: 1 },
              updatedAt: at,
            },
          ],
        }
      : {};
  const hourlyRoute = (enabled: boolean): StoryRow => ({
    id: routeId,
    name: "Hourly bank sync",
    enabled,
    trigger: { kind: "schedule", cron: "0 * * * *" },
  });
  const nextSync = { id: routeId, nextOccurrenceAt: hours(-1) };
  /**
   * The sync's runs, newest first: one run started at each time when the sync starts a run per
   * occurrence, or the worker's single run, as the newest of them left it.
   */
  const syncRuns = (
    runs: [status: RunStatus, startedAt: Date, errorMessage?: string][],
  ): StoryRow[] => {
    const run = (status: RunStatus, startedAt: Date, errorMessage: string | null) => {
      const endedAt = new Date(startedAt.getTime() + 2 * 60_000);
      return {
        workflowName: "codemode-script",
        status,
        errorMessage,
        createdAt: startedAt,
        startedAt,
        completedAt: status === "complete" ? endedAt : null,
        updatedAt: status === "active" ? startedAt : endedAt,
      };
    };
    if ("workflowName" in names) {
      return runs.map(([status, startedAt, errorMessage], index) => ({
        id: `run-${names.workflowName}-${index}`,
        remoteWorkflowName: names.workflowName,
        instanceId: `${names.workflowName}-${startedAt.getTime()}`,
        ...run(status, startedAt, errorMessage ?? null),
      }));
    }
    // A worker waits for the next signal after each poll it completes.
    const [status, startedAt, errorMessage] = runs[0];
    return [
      {
        id: `run-${names.workerInstanceId}`,
        remoteWorkflowName: "bank-sync-worker",
        instanceId: names.workerInstanceId,
        ...run(status === "complete" ? "waiting" : status, startedAt, errorMessage ?? null),
      },
    ];
  };
  const revoked = "The bank API returned 401 Unauthorized: the API token was revoked.";

  const synced = storyScope({
    events: events.map((event) => ({ ...event, source })),
    ...syncHealth(minutes(58)),
    routes: [hourlyRoute(true)],
    route_schedules: [nextSync],
    runs: syncRuns([
      ["complete", minutes(60)],
      ["complete", minutes(120)],
      ["complete", minutes(180)],
    ]),
  });
  return {
    synced,
    // Its token was revoked, and someone paused the schedule.
    failing: {
      ...synced,
      ...storyScope({
        ...syncHealth(hours(7)),
        routes: [hourlyRoute(false)],
        route_schedules: [{ id: routeId, nextOccurrenceAt: null }],
        runs: syncRuns([
          ["errored", hours(6), revoked],
          ["complete", hours(7)],
        ]),
      }),
    },
    // The first sync is still importing, so nothing has been emitted yet.
    firstSync: {
      ...withoutRows(synced),
      ...storyScope({
        routes: [hourlyRoute(true)],
        route_schedules: [nextSync],
        runs: syncRuns([["active", minutes(1)]]),
      }),
    },
  };
}
