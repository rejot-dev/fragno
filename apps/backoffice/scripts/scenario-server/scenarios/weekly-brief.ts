// The weekly overdue-jobs brief: Harbor Home Services' champion, Ada, built a check from the rules
// she used to apply by hand each Friday, and a page that shows its brief. A new week's export runs
// through the same check, and Grace, who leads Harbor, opens the result in the company workspace.
// It follows the demo script and worked example of Leyway's positioning.
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import { allLocalObjects } from "../../../app/backoffice-runtime/all-local-objects";
import {
  backofficeFiles,
  defineBackofficeScenario,
  type BackofficeScenarioContext,
} from "../../../app/fragno/automation/scenario";
import type { ScenarioModuleInput } from "../scenario-server";

const DASHBOARD = "/backoffice/dashboard/org/harbor";
const BRIEF_PAGE = `${DASHBOARD}/pages/briefs/overdue-jobs`;
const EXPORT_PATH = "/workspace/exports/open-jobs.csv";
const WORKFLOW_PATH = "/workspace/briefs/overdue-jobs.workflow.js";
const PAGE_PATH = "/workspace/briefs/overdue-jobs.page.js";
const ROUTE_ID = "friday-overdue-jobs-brief";

// The job system's export, as Ada downloads it each Friday. Each brief compares its export with the
// brief of the export before it, which the workflow keeps by export date, so a run on the same
// export writes the same brief.
const WEEK_1_EXPORT = `job,title,due,status,exported_on
J-1033,Window fit,2026-11-12,Complete,2026-11-20
J-1042,Roof install,2026-11-10,In progress,2026-11-20
J-1057,Boiler service,2026-11-17,Scheduled,2026-11-20
J-1061,Kitchen refit,2026-11-08,Waiting on client,2026-11-20
J-1066,Gutter repair,2026-11-22,In progress,2026-11-20
J-1070,Fence repair,2026-12-04,Scheduled,2026-11-20
`;

const WEEK_2_EXPORT = `job,title,due,status,exported_on
J-1042,Roof install,2026-11-10,Complete,2026-11-27
J-1057,Boiler service,2026-11-17,Scheduled,2026-11-27
J-1061,Kitchen refit,2026-11-08,Waiting on client,2026-11-27
J-1066,Gutter repair,2026-11-22,In progress,2026-11-27
J-1070,Fence repair,2026-12-04,Scheduled,2026-11-27
`;

// The rules Ada gave the agent, as the workflow it wrote applies them:
// - A job is overdue when its due date has passed and it isn't complete.
// - Leave out jobs waiting on the client, but list them separately.
// - Anything more than 7 days overdue needs a decision.
const WORKFLOW = `const BRIEF = "/workspace/briefs";
// Every brief, by its export's date: the brief before an export's date is its last week.
const HISTORY = BRIEF + "/history";
const SECTIONS = ["needs-decision", "watch", "left-out", "dropped-off"];
const DAY = 24 * 60 * 60 * 1000;

function parse(csv) {
  const [header, ...lines] = csv.trim().split("\\n");
  const columns = header.split(",");
  return lines.map((line, index) => {
    const cells = line.split(",");
    const row = Object.fromEntries(columns.map((column, i) => [column, cells[i]]));
    // The export's header is line 1.
    return { ...row, line: index + 2 };
  });
}

function write(rows) {
  const columns = ["job", "title", "due", "status", "why", "change", "line"];
  return [columns.join(","), ...rows.map((row) => columns.map((column) => row[column]).join(","))].join("\\n") + "\\n";
}

export default defineWorkflow({ name: "overdue-jobs-brief" }, async (event, step) => {
  const exported = await step.do("read the export", async () =>
    await state.readFile({ path: "/workspace/exports/open-jobs.csv" }),
  );
  const asOf = parse(exported)[0].exported_on;
  const previous = await step.do("read last week's brief", async () => {
    const dates = (await state.exists({ path: HISTORY })) ? await state.readdir({ path: HISTORY }) : [];
    // ISO dates sort as text.
    const before = dates.filter((date) => date < asOf).sort().pop();
    if (!before) {
      return null;
    }
    const sections = {};
    for (const section of SECTIONS) {
      sections[section] = await state.readFile({ path: HISTORY + "/" + before + "/" + section + ".csv" });
    }
    return sections;
  });

  const brief = await step.do("apply the rules", async () => {
    const jobs = parse(exported);
    const firstBrief = previous === null;
    const lastWeek = (section) =>
      new Set(firstBrief ? [] : parse(previous[section]).map((row) => row.job));
    const decidedBefore = lastWeek("needs-decision");
    const watchedBefore = lastWeek("watch");
    const leftOutBefore = lastWeek("left-out");
    const sections = { "needs-decision": [], watch: [], "left-out": [], "dropped-off": [] };
    for (const job of jobs) {
      const overdueDays = Math.round((Date.parse(asOf) - Date.parse(job.due)) / DAY);
      const wasListed =
        decidedBefore.has(job.job) || watchedBefore.has(job.job) || leftOutBefore.has(job.job);
      if (job.status === "Complete") {
        if (wasListed) {
          sections["dropped-off"].push({ ...job, why: "Marked complete", change: "Dropped off" });
        }
        continue;
      }
      if (overdueDays <= 0) {
        continue;
      }
      if (job.status === "Waiting on client") {
        sections["left-out"].push({
          ...job,
          why: overdueDays + " days overdue; waiting on client",
          change: firstBrief ? "First brief" : leftOutBefore.has(job.job) ? "Still waiting on client" : "New",
        });
      } else if (overdueDays > 7) {
        sections["needs-decision"].push({
          ...job,
          why: overdueDays + " days overdue",
          change: firstBrief
            ? "First brief"
            : decidedBefore.has(job.job)
              ? "Still needs a decision"
            : watchedBefore.has(job.job)
                ? "Now more than 7 days overdue"
                : "New",
        });
      } else {
        sections.watch.push({
          ...job,
          why: overdueDays + " days overdue",
          change: firstBrief ? "First brief" : watchedBefore.has(job.job) ? "Still overdue" : "Newly overdue",
        });
      }
    }
    return { asOf, sections };
  });

  await step.do("write the brief", async () => {
    for (const section of SECTIONS) {
      const content = write(brief.sections[section]);
      await state.writeFile({ path: HISTORY + "/" + brief.asOf + "/" + section + ".csv", content });
      await state.writeFile({ path: BRIEF + "/" + section + ".csv", content });
    }
    await state.writeFile({
      path: BRIEF + "/summary.json",
      content: JSON.stringify({
        asOf: brief.asOf,
        needsDecision: brief.sections["needs-decision"].length,
        watch: brief.sections.watch.length,
      }),
    });
  });

  return {
    asOf: brief.asOf,
    needsDecision: brief.sections["needs-decision"].map((row) => row.job),
    watch: brief.sections.watch.map((row) => row.job),
  };
});
`;

const PAGE = `// Which overdue jobs need a decision on Monday: the brief the Friday run writes from the export.
const columns = {
  job: "string",
  title: "string",
  due: "string",
  status: "string",
  why: "string",
  change: "string",
  line: "number",
};

function section(rows, title, empty) {
  return ui.panelTable(
    {
      title,
      columns: [{ label: "Why" }, { label: "Since last week" }, { label: "Export line", align: "end" }],
      empty,
    },
    ui.each(rows, (row) =>
      ui.panelTableRow({ title: row.job }, [
        ui.text({ text: row.why }),
        ui.text({ text: row.change, tone: "muted" }),
        ui.number({ value: row.line, format: "integer" }),
      ]),
    ),
  );
}

export default page.define({ title: "Overdue jobs" }, ({ sql, file }) => {
  const summary = file.json("/workspace/briefs/summary.json");
  const decide = file.csv("/workspace/briefs/needs-decision.csv", columns);
  const watch = file.csv("/workspace/briefs/watch.csv", columns);
  const leftOut = file.csv("/workspace/briefs/left-out.csv", columns);
  const droppedOff = file.csv("/workspace/briefs/dropped-off.csv", columns);

  const lastRun = sql\`
    SELECT workflowName, instanceId, status, updatedAt FROM runs
    WHERE remoteWorkflowName = 'overdue-jobs-brief'
    ORDER BY createdAt DESC, id DESC LIMIT 1
  \`.columns({
    workflowName: "string",
    instanceId: "string",
    status: ["active", "paused", "waiting", "complete", "errored", "terminated"],
    updatedAt: "time",
  });

  const brief = ui.stack({ gap: "xl" }, [
    ui.metric({
      label: "Need a decision on Monday",
      value: summary.needsDecision,
      format: "integer",
      detail: "Jobs more than 7 days overdue in the export",
    }),
    section(decide, "Needs a decision", "No job is more than 7 days overdue."),
    section(watch, "Watch", "No job is newly overdue."),
    section(leftOut, "Left out: waiting on client", "No overdue job is waiting on the client."),
    section(droppedOff, "Dropped off since last week", "Nothing dropped off."),
  ]);

  const machinery = ui.panel(
    { title: "Friday run", link: { label: "View schedule", to: { kind: "route", id: "${ROUTE_ID}" } } },
    [
      ui.rowList(
        { empty: "The brief has not run yet." },
        ui.each(lastRun, (run) =>
          ui.listRow(
            {
              title: "Last run",
              detail: "Every Friday at 07:00",
              icon: "clock",
              to: { kind: "run", workflowName: run.workflowName, instanceId: run.instanceId },
            },
            [
            ui.runStatus({ status: run.status }),
            ui.relativeTime({ time: run.updatedAt }),
            ],
          ),
        ),
      ),
    ],
  );

  return ui.grid({ columns: "main-side", gap: "xl" }, [brief, machinery]);
});
`;

/** Harbor's ID, which creating it captured. */
function orgId(ctx: BackofficeScenarioContext): string {
  return String(ctx.vars.orgId);
}

function harbor(ctx: BackofficeScenarioContext) {
  return { kind: "org", orgId: orgId(ctx), jurisdiction: null } as const;
}

export default function weeklyBrief({ origin, view, later }: ScenarioModuleInput) {
  return defineBackofficeScenario({
    name: "The Friday brief: which overdue jobs need a decision",
    objects: allLocalObjects,
    env: { DOCS_PUBLIC_BASE_URL: origin },
    files: backofficeFiles.workspace(),
    vars: () => ({ ada: "", grace: "", orgId: "", invitationId: "" }),
    setup: ({ given, when }) => [
      // Signed up at the server's origin, so the browser can take over their session cookies.
      when.auth.signUp({ email: "ada@harbor.example", origin, captureSessionCookieAs: "ada" }),
      when.auth.createOrganization({
        cookie: ({ vars }) => vars.ada,
        name: "Harbor Home Services",
        slug: "harbor",
        captureOrganizationIdAs: "orgId",
        origin,
      }),
      when.auth.signUp({ email: "grace@harbor.example", origin, captureSessionCookieAs: "grace" }),
      when.auth.inviteMember({
        cookie: ({ vars }) => vars.ada,
        organizationId: ({ vars }) => vars.orgId,
        email: "grace@harbor.example",
        role: "member",
        captureInvitationIdAs: "invitationId",
        origin,
      }),
      when.auth.acceptInvitation({
        cookie: ({ vars }) => vars.grace,
        invitationId: ({ vars }) => vars.invitationId,
        origin,
      }),
      later("Ada saves the check the agent wrote with her", (ctx) =>
        given.direct.file({ orgId: orgId(ctx), path: WORKFLOW_PATH, content: WORKFLOW }),
      ),
      later("Ada saves the brief's page", (ctx) =>
        given.direct.file({ orgId: orgId(ctx), path: PAGE_PATH, content: PAGE }),
      ),
      {
        type: "artifacts.buildPage",
        label: "Ada builds the page, as the agent checks it",
        run: async (ctx) => {
          const { result } = await ctx.runCodemode({
            scope: harbor(ctx),
            code: `async () => await artifacts.buildPage({ path: "${PAGE_PATH}" })`,
          });
          const build = result as { status: "built" } | { status: "failed"; message: string };
          if (build.status === "failed") {
            throw new Error(`The brief's page does not build: ${build.message}`);
          }
        },
      },
      later("Ada schedules the check for Friday mornings", (ctx) =>
        given.router.route({
          orgId: orgId(ctx),
          id: ROUTE_ID,
          name: "Friday overdue-jobs brief",
          enabled: true,
          trigger: {
            kind: "schedule",
            cadence: { kind: "cron", expression: "0 7 * * 5", timeZone: "UTC" },
          },
          priority: 50,
          action: {
            kind: "start_workflow",
            authority: {
              kind: "organization-automation",
              grants: [BACKOFFICE_PERMISSION.upload.read, BACKOFFICE_PERMISSION.upload.modify],
            },
            workflowScriptPath: WORKFLOW_PATH,
            instanceIdTemplate: "brief-${event.id}",
          },
        }),
      ),
      later("Last Friday's export", (ctx) =>
        given.direct.file({ orgId: orgId(ctx), path: EXPORT_PATH, content: WEEK_1_EXPORT }),
      ),
      later("Last Friday's run", (ctx) =>
        given.codemode.run({
          scope: harbor(ctx),
          label: "run the brief now",
          code: `async () => await router.triggerNow({ id: "${ROUTE_ID}" })`,
        }),
      ),
    ],
    steps: ({ when }) => [
      view.navigate(`/__scenario/sign-in/ada?to=${BRIEF_PAGE}`, "Ada opens last Friday's brief"),
      view.highlight(
        { text: "J-1042" },
        "Last week: the roof install was 10 days overdue, so it needed a decision.",
      ),
      later("Ada uploads this Friday's export", (ctx) =>
        when.codemode.run({
          scope: harbor(ctx),
          label: "upload this Friday's export",
          code: `async () => await state.writeFile({ path: "${EXPORT_PATH}", content: ${JSON.stringify(WEEK_2_EXPORT)} })`,
        }),
      ),
      later("The Friday run: the same check on the new export", (ctx) =>
        when.codemode.run({
          scope: harbor(ctx),
          label: "run the brief now",
          code: `async () => await router.triggerNow({ id: "${ROUTE_ID}" })`,
        }),
      ),
      // Targets only the new brief shows, so each waits for the page to show it.
      view.highlight(
        { text: "Now more than 7 days overdue" },
        "The boiler service is now more than 7 days overdue. Nobody rewrote the rules.",
      ),
      view.highlight(
        { text: "Marked complete" },
        "The roof install was completed, so it dropped off.",
      ),
      view.navigate(
        `/__scenario/sign-in/grace?to=${BRIEF_PAGE}`,
        "Grace, who runs Harbor, opens the same brief",
      ),
      view.highlight(
        { text: "Need a decision on Monday" },
        "Grace sees what needs a call, and the export line behind each job.",
      ),
      view.click({ text: "Last run" }, "Grace opens the run behind it"),
      view.highlight({ text: "apply the rules" }, "Each Friday's run, step by step."),
    ],
  });
}
