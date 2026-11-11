import { useEffect, useState, type ReactNode } from "react";

import { ScrollablePre } from "../data/scrollable-pre";
import { ChatActivity, ChatActivityStep, ChatArtifactToggle } from "./chat-activity";
import {
  ChatCodemodeStep,
  codemodeCallHeadline,
  type ChatCodemodeCall,
  type ChatCodemodeCallSubject,
  type ChatCodemodeCalls,
} from "./chat-codemode-step";

export default { title: "Agents/Codemode step" };

function Column({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex max-w-3xl flex-col gap-6">{children}</div>;
}

function ReplayButton({ onReplay }: { onReplay: () => void }) {
  return (
    <button
      type="button"
      className="self-start text-xs text-[var(--bo-accent-fg)] underline"
      onClick={onReplay}
    >
      Replay
    </button>
  );
}

/** Plays a run from its start to `endMs` in real time, from the start again on every replay. */
function usePlayback(endMs: number) {
  const [replays, setReplays] = useState(0);
  const [atMs, setAtMs] = useState(0);
  const [startedAt, setStartedAt] = useState(() => new Date());
  useEffect(() => {
    const start = Date.now();
    setStartedAt(new Date(start));
    setAtMs(0);
    const interval = setInterval(() => {
      const elapsed = Math.min(Date.now() - start, endMs);
      setAtMs(elapsed);
      if (elapsed === endMs) {
        clearInterval(interval);
      }
    }, 50);
    return () => {
      clearInterval(interval);
    };
  }, [replays, endMs]);
  return {
    atMs,
    startedAt,
    replay: () => {
      setReplays((current) => current + 1);
    },
  };
}

/** A call as recorded: when it started, how long it took, and how it failed, if it did. */
type SampleCall = {
  id: string;
  subject: ChatCodemodeCallSubject;
  offsetMs: number;
  durationMs: number;
  error: string | null;
};

const DISCOVERY_CODE = `async () => {
  const skills = await state.glob({ pattern: "/static/skills/**/SKILL.md" });
  const [skill, notes] = await Promise.all([
    state.readFile({ path: "/static/skills/payment-reminders/SKILL.md" }),
    state.readFile({ path: "/workspace/notes/billing.md" }),
  ]);
  return { skills, skill, notes };
}`;

const DISCOVERY: SampleCall[] = [
  {
    id: "d1",
    subject: { kind: "list", pattern: "/static/skills/**/SKILL.md" },
    offsetMs: 0,
    durationMs: 38,
    error: null,
  },
  {
    id: "d2",
    subject: { kind: "skill", name: "payment-reminders" },
    offsetMs: 40,
    durationMs: 14,
    error: null,
  },
  {
    id: "d3",
    subject: { kind: "read", path: "/workspace/notes/billing.md" },
    offsetMs: 40,
    durationMs: 11,
    error: null,
  },
];

const REMINDER_CODE = `async () => {
  const policy = await state.searchFiles({ pattern: "/workspace/**/*.md", keywords: ["overdue"] });
  const invoices = await bookkeeping.invoices.list({ status: "unpaid" });
  const contacts = await Promise.all(
    invoices.map((invoice) => crm.contacts.get({ id: invoice.contactId })),
  );
  for (const [index, invoice] of invoices.entries()) {
    await email.send({ to: contacts[index].email, template: "reminder", invoice: invoice.id });
  }
  return { reminded: invoices.length, policy: policy.matches.length };
}`;

const REMINDERS: SampleCall[] = [
  {
    id: "r1",
    subject: { kind: "search", keywords: ["overdue"], pattern: "/workspace/**/*.md" },
    offsetMs: 0,
    durationMs: 64,
    error: null,
  },
  {
    id: "r2",
    subject: {
      kind: "action",
      connectionId: "app#bookkeeping",
      actionId: "invoices.list",
      scope: null,
      input: '{"status":"unpaid"}',
    },
    offsetMs: 70,
    durationMs: 420,
    error: null,
  },
  {
    id: "r3",
    subject: { kind: "call", name: "crm.contacts.get", scope: null, input: '{"id":"con_acme"}' },
    offsetMs: 500,
    durationMs: 180,
    error: null,
  },
  {
    id: "r4",
    subject: { kind: "call", name: "crm.contacts.get", scope: null, input: '{"id":"con_globex"}' },
    offsetMs: 500,
    durationMs: 210,
    error: null,
  },
  {
    id: "r5",
    subject: {
      kind: "call",
      name: "crm.contacts.get",
      scope: "org:initech-holdings",
      input: '{"id":"con_initech"}',
    },
    offsetMs: 501,
    durationMs: 260,
    error: null,
  },
  {
    id: "r6",
    subject: {
      kind: "call",
      name: "email.send",
      scope: null,
      input: '{"to":"ap@acme.test","template":"reminder","invoice":"INV-4182"}',
    },
    offsetMs: 770,
    durationMs: 520,
    error: null,
  },
  {
    id: "r7",
    subject: {
      kind: "call",
      name: "email.send",
      scope: null,
      input: '{"to":"billing@globex.test","template":"reminder","invoice":"INV-4190"}',
    },
    offsetMs: 1_300,
    durationMs: 90,
    error:
      "billing@globex.test bounced on Oct 18 and is suppressed. Remove it from the suppression list to send again.",
  },
  {
    id: "r8",
    subject: {
      kind: "call",
      name: "email.send",
      scope: null,
      input: '{"to":"finance@initech.test","template":"reminder","invoice":"INV-4203"}',
    },
    offsetMs: 1_400,
    durationMs: 480,
    error: null,
  },
];

const REMINDERS_MS = 1_900;

/** The calls as a viewer sees them `atMs` into the run: started ones, settled once they ended. */
function callsAt(calls: readonly SampleCall[], atMs: number): ChatCodemodeCall[] {
  return calls
    .filter((call) => call.offsetMs <= atMs)
    .map(({ id, subject, offsetMs, durationMs, error }) =>
      offsetMs + durationMs > atMs
        ? { id, subject, offsetMs, status: "running" }
        : error === null
          ? { id, subject, offsetMs, status: "succeeded", durationMs }
          : { id, subject, offsetMs, status: "failed", durationMs, error },
    );
}

/** A finished run's calls, on a timeline that started at the epoch; settled runs ignore it. */
function settledCalls(calls: readonly SampleCall[], unrecorded: number): ChatCodemodeCalls {
  return { startedAt: new Date(0), items: callsAt(calls, Infinity), unrecorded };
}

function views(code: string, result: string | null, logs: string | null) {
  return [
    { label: "Code", content: <ScrollablePre>{code}</ScrollablePre> },
    ...(result === null
      ? []
      : [{ label: "Result", content: <ScrollablePre>{result}</ScrollablePre> }]),
    ...(logs === null ? [] : [{ label: "Logs", content: <ScrollablePre>{logs}</ScrollablePre> }]),
  ];
}

const REMINDER_RESULT = '{ "reminded": 3, "policy": 2 }';
const REMINDER_LOGS = "sent INV-4182\nskipped INV-4190: bounced\nsent INV-4203";

function Thought({ title, children }: { title: string; children: string }) {
  return (
    <ChatActivityStep
      icon={null}
      state="done"
      title={title}
      detail={null}
      durationMs={null}
      actions={null}
    >
      <p className="text-xs leading-5 text-[var(--bo-muted)]">{children}</p>
    </ChatActivityStep>
  );
}

function InterfaceToggle() {
  const [pressed, setPressed] = useState(false);
  return (
    <ChatArtifactToggle
      icon="layout"
      label="Interface"
      labelled={false}
      pressed={pressed}
      onClick={() => {
        setPressed((current) => !current);
      }}
    />
  );
}

/**
 * A whole turn: discovery reads as what it found, and each run opens on its calls. Code, result, and
 * logs are the other tabs in the run's header; picking the open tab again folds the run.
 */
export function Turn() {
  const [startedAt] = useState(() => new Date(Date.now() - 23_000));
  return (
    <Column>
      <ChatActivity
        status={{ kind: "running", headline: "Sending one reminder per invoice", startedAt }}
        artifacts={null}
      >
        <Thought title="Finding the reminder skill">
          The user wants reminders for overdue invoices. There is probably a skill for this; list
          the skills and read the billing notes in the same run.
        </Thought>
        <ChatCodemodeStep
          state="done"
          detail={null}
          calls={settledCalls(DISCOVERY, 0)}
          durationMs={96}
          views={views(
            DISCOVERY_CODE,
            '{ "skills": ["…"], "skill": "# Payment reminders…" }',
            null,
          )}
          actions={null}
        />
        <Thought title="Sending one reminder per invoice">
          The skill says to look up each contact before sending and to skip suppressed addresses.
        </Thought>
        <ChatCodemodeStep
          state="done"
          detail={null}
          calls={settledCalls(REMINDERS, 0)}
          durationMs={REMINDERS_MS}
          views={views(REMINDER_CODE, REMINDER_RESULT, REMINDER_LOGS)}
          actions={<InterfaceToggle />}
        />
      </ChatActivity>
    </Column>
  );
}

const WAITING_CODE = `async () => {
  for (let i = 0; i < 5; i++) {
    await state.readFile({ path: "/static/codemode/providers/store.d.ts" });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await store.list({ limit: 100 });
  }
}`;

const WAITING_MS = 10_080;

// Each iteration reads, waits two seconds without calling anything, then lists.
const WAITING: SampleCall[] = Array.from({ length: 5 }, (_, index) => [
  {
    id: `read-${index}`,
    subject: { kind: "read", path: "/static/codemode/providers/store.d.ts" } as const,
    offsetMs: 40 + index * 2_012,
    durationMs: index === 0 ? 3 : 1,
    error: null,
  },
  {
    id: `list-${index}`,
    subject: {
      kind: "call",
      name: "store.list",
      scope: null,
      input: '{"limit":100}',
    } as const,
    offsetMs: 40 + index * 2_012 + 2_003,
    durationMs: index === 0 ? 10 : 6,
    error: null,
  },
]).flat();

/**
 * A program that spends most of its time between calls: every call takes milliseconds, and the bars
 * show where the two-second waits went.
 */
export function TimeBetweenCalls() {
  const [startedAt] = useState(() => new Date(Date.now() - 18_000));
  return (
    <Column>
      <ChatActivity
        status={{ kind: "running", headline: "Writing the summary", startedAt }}
        artifacts={null}
      >
        <ChatCodemodeStep
          state="done"
          detail={null}
          calls={settledCalls(WAITING, 0)}
          durationMs={WAITING_MS}
          views={views(WAITING_CODE, '{ "iterations": [ … ] }', null)}
          actions={null}
        />
      </ChatActivity>
    </Column>
  );
}

const WRITING_MS = 1_200;

/**
 * The run as it happens, in real time: while the model writes the program the step says so, then
 * calls arrive as the program makes them. The step keeps the run's clock, so earlier calls drift
 * left through the waits between calls, as they do when a server reports calls only as they happen.
 */
export function Live() {
  const endMs = WRITING_MS + WAITING_MS;
  const { atMs, startedAt, replay } = usePlayback(endMs);
  const settled = atMs >= endMs;

  const writing = atMs < WRITING_MS;
  const items = writing ? [] : callsAt(WAITING, atMs - WRITING_MS);
  const running = items.filter((call) => call.status === "running");
  const newest = running.at(-1);

  return (
    <Column>
      <ReplayButton onReplay={replay} />
      <ChatActivity
        status={{
          kind: "running",
          headline: settled
            ? "Writing the summary"
            : writing
              ? "Writing code"
              : newest === undefined
                ? "Running codemode"
                : codemodeCallHeadline(newest.subject),
          startedAt,
        }}
        artifacts={null}
      >
        <ChatCodemodeStep
          state={settled ? "done" : "running"}
          detail={writing ? "writing code…" : null}
          calls={
            items.length === 0
              ? null
              : {
                  startedAt: new Date(startedAt.getTime() + WRITING_MS),
                  items,
                  unrecorded: 0,
                }
          }
          durationMs={settled ? WAITING_MS : null}
          views={views(WAITING_CODE, settled ? '{ "iterations": [ … ] }' : null, null)}
          actions={null}
        />
      </ChatActivity>
    </Column>
  );
}

/** A run without calls, such as a computation, shows its first line of code instead. */
export function WithoutCalls() {
  const [startedAt] = useState(() => new Date(Date.now() - 4_000));
  return (
    <Column>
      <ChatActivity
        status={{ kind: "running", headline: "Writing the summary", startedAt }}
        artifacts={null}
      >
        <ChatCodemodeStep
          state="done"
          detail="async () => ({ scope: await context.getCurrentScope() })"
          calls={null}
          durationMs={85}
          views={views(
            "async () => ({ scope: await context.getCurrentScope() })",
            '{ "scope": { "kind": "user" } }',
            null,
          )}
          actions={null}
        />
        <ChatCodemodeStep
          state="failed"
          detail={'throw new Error("Payment provider unavailable")'}
          calls={null}
          durationMs={12}
          views={views(
            'async () => { throw new Error("Payment provider unavailable"); }',
            "Error: Payment provider unavailable",
            null,
          )}
          actions={null}
        />
      </ChatActivity>
    </Column>
  );
}

/**
 * A lookup fanned out over 40 contacts: the list folds to its newest calls, keeping the failure in
 * view, and calls past the record's cap are counted.
 */
export function ManyCalls() {
  const [startedAt] = useState(() => new Date(Date.now() - 9_000));
  const fanned: ChatCodemodeCall[] = [
    {
      id: "list",
      subject: {
        kind: "call",
        name: "crm.contacts.list",
        scope: null,
        input: '{"tag":"churn-risk"}',
      },
      offsetMs: 0,
      status: "succeeded",
      durationMs: 310,
    },
    ...Array.from({ length: 40 }, (_, index): ChatCodemodeCall => {
      const subject: ChatCodemodeCallSubject = {
        kind: "call",
        name: "crm.deals.get",
        scope: null,
        input: `{"contactId":"con_${1000 + index}"}`,
      };
      const durationMs = 140 + ((index * 37) % 220);
      return index === 17
        ? {
            id: `get-${index}`,
            subject,
            offsetMs: 320 + (index % 4),
            status: "failed",
            durationMs,
            error: "CRM rate limit reached; retry after 2s.",
          }
        : {
            id: `get-${index}`,
            subject,
            offsetMs: 320 + (index % 4),
            status: "succeeded",
            durationMs,
          };
    }),
  ];
  return (
    <Column>
      <ChatActivity
        status={{ kind: "running", headline: "Ranking accounts by risk", startedAt }}
        artifacts={null}
      >
        <ChatCodemodeStep
          state="done"
          detail={null}
          calls={{ startedAt: new Date(0), items: fanned, unrecorded: 12 }}
          durationMs={720}
          views={views("async () => { /* … */ }", '{ "ranked": 52 }', null)}
          actions={null}
        />
      </ChatActivity>
    </Column>
  );
}

const CUSTOMERS = [
  "acme",
  "globex",
  "initech",
  "umbrella",
  "hooli",
  "stark",
  "wayne",
  "wonka",
  "tyrell",
  "cyberdyne",
  "soylent",
  "aperture",
  "massive",
  "oscorp",
  "vandelay",
  "gekko",
  "dunder",
  "pied-piper",
  "prestige",
  "monarch",
];

const SWEEP_CODE = `async () => {
  const customers = await crm.contacts.list({ tag: "overdue" });
  for (const customer of customers) {
    const invoice = await bookkeeping.invoices.latest({ contactId: customer.id });
    await email.send({ to: customer.email, template: "reminder", invoice: invoice.id });
  }
}`;

// One customer at a time: look up the latest invoice, then send its reminder. One address bounced.
const SWEEP: SampleCall[] = [
  {
    id: "list",
    subject: { kind: "call", name: "crm.contacts.list", scope: null, input: '{"tag":"overdue"}' },
    offsetMs: 0,
    durationMs: 380,
    error: null,
  },
  ...CUSTOMERS.flatMap((customer, index): SampleCall[] => {
    const offsetMs = 420 + index * 640;
    return [
      {
        id: `invoice-${customer}`,
        subject: {
          kind: "action",
          connectionId: "app#bookkeeping",
          actionId: "invoices.latest",
          scope: null,
          input: `{"contactId":"con_${customer}"}`,
        },
        offsetMs,
        durationMs: 180 + ((index * 53) % 120),
        error: null,
      },
      {
        id: `send-${customer}`,
        subject: {
          kind: "call",
          name: "email.send",
          scope: null,
          input: `{"to":"ap@${customer}.test","template":"reminder"}`,
        },
        offsetMs: offsetMs + 320,
        durationMs: 240 + ((index * 31) % 60),
        error:
          index === 3
            ? "ap@umbrella.test bounced on Oct 18 and is suppressed. Remove it from the suppression list to send again."
            : null,
      },
    ];
  }),
];

const SWEEP_MS = 420 + CUSTOMERS.length * 640;

/**
 * A run longer than the fold, as it happens: one call after another, well past the first eight. The
 * folded list follows the run, showing its newest calls and the failure further back.
 */
export function LiveLongRun() {
  const endMs = WRITING_MS + SWEEP_MS;
  const { atMs, startedAt, replay } = usePlayback(endMs);
  const settled = atMs >= endMs;
  const writing = atMs < WRITING_MS;
  const items = writing ? [] : callsAt(SWEEP, atMs - WRITING_MS);
  const newest = items.filter((call) => call.status === "running").at(-1);
  return (
    <Column>
      <ReplayButton onReplay={replay} />
      <ChatActivity
        status={{
          kind: "running",
          headline: settled
            ? "Writing the summary"
            : writing
              ? "Writing code"
              : newest === undefined
                ? "Running codemode"
                : codemodeCallHeadline(newest.subject),
          startedAt,
        }}
        artifacts={null}
      >
        <ChatCodemodeStep
          state={settled ? "done" : "running"}
          detail={writing ? "writing code…" : null}
          calls={
            items.length === 0
              ? null
              : {
                  startedAt: new Date(startedAt.getTime() + WRITING_MS),
                  items,
                  unrecorded: 0,
                }
          }
          durationMs={settled ? SWEEP_MS : null}
          views={views(SWEEP_CODE, settled ? '{ "reminded": 19 }' : null, null)}
          actions={null}
        />
      </ChatActivity>
    </Column>
  );
}
